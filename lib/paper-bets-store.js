// Apuestas sin dinero — persistencia. La lógica de clasificación y de
// resultados vive en lib/paper-bets.js; aquí solo se lee y se escribe.

import {
  betOutcome, classifyMarketFamily, classifyMarketPeriod, combinedOdd, legTeamSide, splitMatchName,
} from './paper-bets.js';

const SPORTS = new Set(['football', 'baseball', 'basketball', 'american_football']);

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentOrNull(value) {
  const parsed = numberOrNull(value);
  return parsed == null ? null : Math.max(0, Math.min(100, Math.round(parsed * 100) / 100));
}

/** Normaliza una selección recibida del cliente a la fila que se guarda. */
export function buildLegRow(input, position = 0) {
  const sport = SPORTS.has(input.sport) ? input.sport : 'football';
  const names = splitMatchName(input.matchName);
  const homeTeam = input.homeTeam || names.home || null;
  const awayTeam = input.awayTeam || names.away || null;
  const manual = input.source === 'manual';
  const marketId = manual ? null : (input.id ? String(input.id).slice(0, 200) : null);
  const marketName = String(input.name || '').trim().slice(0, 300);
  const family = input.family && manual
    ? String(input.family)
    : classifyMarketFamily({ id: marketId, name: marketName, scope: input.scope });
  return {
    position,
    sport,
    fixture_id: manual || input.fixtureId == null ? null : String(input.fixtureId).slice(0, 120),
    kickoff: input.kickoff ? new Date(input.kickoff) : null,
    league_name: input.leagueName ? String(input.leagueName).slice(0, 120) : null,
    home_team: homeTeam ? String(homeTeam).slice(0, 120) : null,
    away_team: awayTeam ? String(awayTeam).slice(0, 120) : null,
    team_side: manual && ['home', 'away'].includes(input.teamSide)
      ? input.teamSide
      : legTeamSide({ id: marketId, name: marketName, side: input.side, homeTeam, awayTeam }),
    market_id: marketId,
    market_name: marketName,
    market_family: family,
    market_period: classifyMarketPeriod({ id: marketId, name: marketName }),
    line: numberOrNull(input.line),
    side: input.side ? String(input.side).slice(0, 20) : null,
    odd: Number(input.odd),
    group_odd: !manual && Number(input.groupOdd) >= 1 ? Number(input.groupOdd) : null,
    probability: percentOrNull(input.probability),
    reliability: percentOrNull(input.reliability),
    bookmaker: input.bookmaker ? String(input.bookmaker).slice(0, 60) : null,
    source: manual ? 'manual' : 'recommended',
  };
}

const LEG_COLUMNS = [
  'position', 'sport', 'fixture_id', 'kickoff', 'league_name', 'home_team', 'away_team', 'team_side', 'market_id',
  'market_name', 'market_family', 'market_period', 'line', 'side', 'odd', 'group_odd', 'probability', 'reliability', 'bookmaker', 'source',
];

export async function createPaperBet(pool, userId, { stake, note, legs }) {
  const rows = legs.map((leg, index) => buildLegRow(leg, index));
  // Una cuota conjunta solo tiene sentido con dos o más selecciones del mismo
  // partido; en una selección suelta se ignora y manda su propia cuota.
  const perFixture = new Map();
  for (const row of rows) {
    if (row.group_odd == null) continue;
    const key = `${row.sport}|${row.fixture_id}`;
    perFixture.set(key, (perFixture.get(key) || 0) + 1);
  }
  for (const row of rows) {
    if (row.group_odd != null && (row.fixture_id == null || perFixture.get(`${row.sport}|${row.fixture_id}`) < 2)) row.group_odd = null;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // La hora del partido sale del registro de pronósticos cuando el cliente
    // no la trae (las selecciones del constructor no la incluyen).
    for (const row of rows) {
      if (row.kickoff || !row.fixture_id) continue;
      const found = await client.query(
        'SELECT kickoff FROM prediction_runs WHERE sport=$1 AND fixture_id=$2 ORDER BY predicted_at DESC LIMIT 1',
        [row.sport, row.fixture_id],
      );
      row.kickoff = found.rows[0]?.kickoff || null;
    }
    const bet = await client.query(
      `INSERT INTO paper_bets(user_id, stake, total_odd, note) VALUES($1,$2,$3,$4)
       RETURNING id, stake, total_odd, status, payout, note, placed_at, settled_at`,
      [userId, stake, combinedOdd(rows), note ? String(note).slice(0, 300) : null],
    );
    for (const row of rows) {
      await client.query(
        `INSERT INTO paper_bet_legs(bet_id, ${LEG_COLUMNS.join(', ')})
         VALUES($1, ${LEG_COLUMNS.map((_, index) => `$${index + 2}`).join(', ')})`,
        [bet.rows[0].id, ...LEG_COLUMNS.map((column) => row[column])],
      );
    }
    await client.query('COMMIT');
    return bet.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function recomputeBets(db, betIds) {
  for (const betId of betIds) {
    const [bet, legs] = await Promise.all([
      db.query('SELECT stake FROM paper_bets WHERE id=$1', [betId]),
      db.query('SELECT status, odd, group_odd, sport, fixture_id FROM paper_bet_legs WHERE bet_id=$1', [betId]),
    ]);
    if (!bet.rows[0]) continue;
    const outcome = betOutcome(bet.rows[0].stake, legs.rows);
    await db.query(
      `UPDATE paper_bets SET status=$2, payout=$3,
         settled_at = CASE WHEN $2 = 'open' THEN NULL ELSE COALESCE(settled_at, now()) END
       WHERE id=$1`,
      [betId, outcome.status, outcome.payout],
    );
  }
}

/**
 * Cierra las selecciones pendientes con el resultado que la web ya liquidó
 * para ese mismo mercado (registro de pronósticos). Una selección manual, o un
 * mercado que el registro no conoce, queda pendiente hasta marcarla a mano.
 */
export async function settlePendingPaperBets(pool, userId) {
  const { rows } = await pool.query(
    `SELECT l.id, l.bet_id, s.outcome
     FROM paper_bet_legs l
     JOIN paper_bets b ON b.id = l.bet_id
     JOIN LATERAL (
       SELECT st.outcome FROM prediction_runs r
       JOIN prediction_settlements st ON st.run_id = r.id
       WHERE r.sport = l.sport AND r.fixture_id = l.fixture_id AND st.market_key = l.market_id
       ORDER BY st.settled_at DESC LIMIT 1
     ) s ON TRUE
     WHERE b.user_id = $1 AND l.status = 'pending' AND l.market_id IS NOT NULL AND l.fixture_id IS NOT NULL`,
    [userId],
  );
  const settled = rows.filter((row) => ['won', 'lost', 'void'].includes(row.outcome));
  if (!settled.length) return 0;
  for (const row of settled) {
    await pool.query(
      `UPDATE paper_bet_legs SET status=$2, settled_by='auto', settled_at=now() WHERE id=$1 AND status='pending'`,
      [row.id, row.outcome],
    );
  }
  await recomputeBets(pool, [...new Set(settled.map((row) => row.bet_id))]);
  return settled.length;
}

export async function listPaperBets(pool, userId) {
  const [bets, legs] = await Promise.all([
    pool.query(
      `SELECT id, stake, total_odd, status, payout, note, placed_at, settled_at
       FROM paper_bets WHERE user_id=$1 ORDER BY placed_at DESC LIMIT 1000`,
      [userId],
    ),
    pool.query(
      `SELECT l.* FROM paper_bet_legs l JOIN paper_bets b ON b.id = l.bet_id
       WHERE b.user_id=$1 ORDER BY l.bet_id, l.position`,
      [userId],
    ),
  ]);
  const byBet = new Map();
  for (const leg of legs.rows) {
    if (!byBet.has(leg.bet_id)) byBet.set(leg.bet_id, []);
    byBet.get(leg.bet_id).push({ ...leg, odd: Number(leg.odd), line: leg.line == null ? null : Number(leg.line),
      group_odd: leg.group_odd == null ? null : Number(leg.group_odd),
      probability: leg.probability == null ? null : Number(leg.probability) });
  }
  return bets.rows.map((bet) => ({
    ...bet, stake: Number(bet.stake), total_odd: Number(bet.total_odd), payout: bet.payout == null ? null : Number(bet.payout),
    legs: byBet.get(bet.id) || [],
  }));
}

/** Resultado puesto a mano en una selección ('pending' lo deshace). */
export async function setPaperLegResult(pool, userId, legId, status) {
  const { rows } = await pool.query(
    `UPDATE paper_bet_legs l
     SET status=$3, settled_by = CASE WHEN $3 = 'pending' THEN NULL ELSE 'manual' END,
         settled_at = CASE WHEN $3 = 'pending' THEN NULL ELSE now() END
     FROM paper_bets b
     WHERE l.id=$2 AND b.id = l.bet_id AND b.user_id=$1
     RETURNING l.bet_id`,
    [userId, legId, status],
  );
  if (!rows[0]) return false;
  await recomputeBets(pool, [rows[0].bet_id]);
  return true;
}

export async function deletePaperBet(pool, userId, betId) {
  const result = await pool.query('DELETE FROM paper_bets WHERE id=$1 AND user_id=$2', [betId, userId]);
  return result.rowCount > 0;
}
