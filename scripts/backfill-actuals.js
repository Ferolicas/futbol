/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Reconstruye actuals_full para los partidos finalizados ANTERIORES al código
// de actuals_full (finalized_at NOT NULL AND actuals_full IS NULL), desde
// raw_api_payloads. PARIDAD TOTAL con finalize.js: getStat + construcción de
// actualsFull copiados verbatim (mismo shape JSONB → sin drift en el training).
//
// NOTA: el actuals_full de finalize NO incluye xG/posesión (esos están en
// features_full/causalidad). Replicamos EXACTO ese shape — añadir campos sería
// introducir el drift que queremos evitar.
//
// Idempotente (WHERE actuals_full IS NULL). node --env-file=.env scripts/backfill-actuals.js
// ────────────────────────────────────────────────────────────────────────
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

// ── COPIA VERBATIM de finalize.js (getStat + extractResult→actualsFull) ──
function getStat(statsObj, ...candidates) {
  const arr = statsObj?.statistics;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const norm = s => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
  const wanted = candidates.map(norm);
  for (const s of arr) {
    if (wanted.includes(norm(s.type))) {
      const v = s.value;
      if (v === null || v === undefined || v === 'null' || v === '') return null;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function buildActualsFull(match) {
  const homeId = match.teams.home.id;
  const awayId = match.teams.away.id;
  const homeStats = (match.statistics || []).find(s => s.team?.id === homeId);
  const awayStats = (match.statistics || []).find(s => s.team?.id === awayId);
  const goalEvents = (match.events || []).filter(e => e.type === 'Goal' && e.detail !== 'Missed Penalty');
  const cardEvents = (match.events || []).filter(e => e.type === 'Card');

  const statusShort = match.fixture?.status?.short ?? null;
  const hGoals = match.goals?.home ?? null;
  const aGoals = match.goals?.away ?? null;
  const ftHome = match.score?.fulltime?.home ?? hGoals;
  const ftAway = match.score?.fulltime?.away ?? aGoals;

  const hCorners = getStat(homeStats, 'Corner Kicks', 'Corners', 'Corner') ?? 0;
  const aCorners = getStat(awayStats, 'Corner Kicks', 'Corners', 'Corner') ?? 0;

  const yh = getStat(homeStats, 'Yellow Cards', 'Yellowcards');
  const ya = getStat(awayStats, 'Yellow Cards', 'Yellowcards');
  const rh = getStat(homeStats, 'Red Cards', 'Redcards');
  const ra = getStat(awayStats, 'Red Cards', 'Redcards');
  const fromStats = [yh, ya, rh, ra].some(v => v != null);
  const totalCards = fromStats ? (yh || 0) + (ya || 0) + (rh || 0) + (ra || 0) : cardEvents.length;

  const hShots   = getStat(homeStats, 'Total Shots')   ?? null;
  const aShots   = getStat(awayStats, 'Total Shots')   ?? null;
  const hSot     = getStat(homeStats, 'Shots on Goal') ?? null;
  const aSot     = getStat(awayStats, 'Shots on Goal') ?? null;
  const hFouls   = getStat(homeStats, 'Fouls')         ?? null;
  const aFouls   = getStat(awayStats, 'Fouls')         ?? null;
  const hOffside = getStat(homeStats, 'Offsides')      ?? null;
  const aOffside = getStat(awayStats, 'Offsides')      ?? null;

  const goalMinutes = goalEvents
    .map(e => (e.time?.elapsed != null ? e.time.elapsed + (e.time.extra || 0) : null))
    .filter(m => m != null)
    .sort((a, b) => a - b);
  const firstGoalMinute = goalMinutes.length > 0 ? goalMinutes[0] : null;

  return {
    status: statusShort,
    result: ftHome === null || ftAway === null ? null : ftHome > ftAway ? 'H' : ftHome < ftAway ? 'A' : 'D',
    goals: {
      home: ftHome, away: ftAway,
      total: ftHome !== null && ftAway !== null ? ftHome + ftAway : null,
      btts: ftHome !== null && ftAway !== null ? (ftHome > 0 && ftAway > 0) : null,
      homeAet: hGoals, awayAet: aGoals,
      totalAet: hGoals !== null && aGoals !== null ? hGoals + aGoals : null,
    },
    corners: { home: hCorners, away: aCorners, total: hCorners + aCorners },
    cards: {
      yellowHome: yh ?? null, yellowAway: ya ?? null, redHome: rh ?? null, redAway: ra ?? null,
      home: (yh ?? 0) + (rh ?? 0), away: (ya ?? 0) + (ra ?? 0), total: totalCards,
    },
    shots: {
      home: hShots, away: aShots,
      total: hShots !== null && aShots !== null ? hShots + aShots : null,
      onTargetHome: hSot, onTargetAway: aSot,
      totalOnTarget: hSot !== null && aSot !== null ? hSot + aSot : null,
    },
    fouls: { home: hFouls, away: aFouls, total: hFouls !== null && aFouls !== null ? hFouls + aFouls : null },
    offsides: { home: hOffside, away: aOffside, total: hOffside !== null && aOffside !== null ? hOffside + aOffside : null },
    firstGoalMinute,
    goalMinutes,
  };
}
// ── fin copia verbatim ──

(async () => {
  console.log('\nCargando crudos (fixtures + statistics + events)…');
  const [{ rows: fxRows }, { rows: stRows }, { rows: evRows }] = await Promise.all([
    pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures'`),
    pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures/statistics'`),
    pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures/events'`),
  ]);
  const fixById = new Map(fxRows.map(r => [Number(r.ref_id), r.payload]));
  const stById = new Map(stRows.map(r => [Number(r.ref_id), r.payload]));
  const evById = new Map(evRows.map(r => [Number(r.ref_id), r.payload]));
  console.log(`  fixtures=${fixById.size} · statistics=${stById.size} · events=${evById.size}`);

  const { rows: preds } = await pool.query(
    `SELECT fixture_id FROM match_predictions WHERE finalized_at IS NOT NULL AND actuals_full IS NULL`
  );
  console.log(`Partidos a reconstruir (finalized, actuals_full NULL): ${preds.length}`);

  let done = 0, noFixture = 0, noStats = 0, failed = 0;
  const cov = { corners: 0, shots: 0 };
  for (const { fixture_id: fid } of preds) {
    try {
      const fx = fixById.get(Number(fid));
      if (!fx || !fx.teams) { noFixture++; continue; }
      const stPayload = stById.get(Number(fid));
      const evPayload = evById.get(Number(fid));
      const match = {
        ...fx,
        statistics: stPayload?.response || stPayload || [],
        events: evPayload?.response || evPayload || [],
      };
      const actualsFull = buildActualsFull(match);
      await pool.query(`UPDATE match_predictions SET actuals_full = $1::jsonb WHERE fixture_id = $2 AND actuals_full IS NULL`, [JSON.stringify(actualsFull), fid]);
      done++;
      if (!Array.isArray(match.statistics) || match.statistics.length === 0) noStats++;
      else { if (actualsFull.corners.total > 0) cov.corners++; if (actualsFull.shots.total != null) cov.shots++; }
    } catch (e) { failed++; console.warn(`  fail fid=${fid}: ${e.message}`); }
  }

  console.log(`\n══ RESUMEN ══`);
  console.log(`Reconstruidos: ${done}/${preds.length} (sin fixture crudo: ${noFixture}, fallos: ${failed})`);
  console.log(`Cobertura → con corners: ${pct(cov.corners, done)} · con shots: ${pct(cov.shots, done)} · sin statistics: ${noStats}`);
  await pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

function pct(n, d) { return d > 0 ? `${Math.round((n / d) * 100)}%` : 'n/a'; }
