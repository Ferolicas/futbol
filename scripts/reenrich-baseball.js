/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Paso 4 — Feature engineering POINT-IN-TIME para baseball ML.
//
// Lee raw_api_payloads (mlb-schedule + mlb-boxscore + mlb-pitcher-season),
// calcula las 10 features definidas en el spec usando SOLO datos
// ANTERIORES a game_date (sin leakage) y persiste en features_baseball.
//
// 10 features:
//   (1) home_win_rate_last_10           — últimos 10 juegos del home en la
//                                          misma temporada, ANTES de game_date.
//                                          Min 5 juegos previos para emitir.
//   (2) home_runs_per_game_last_30      — promedio runs ANOTADAS en juegos
//                                          de los últimos 30 días, misma temporada.
//                                          Min 3 juegos previos para emitir.
//   (3) home_runs_allowed_last_30       — promedio runs RECIBIDAS, ídem.
//   (4-6) away_* — análogo para el visitante.
//   (7) home_starter_era_last_5         — ERA de las últimas 5 aperturas del
//                                          starter (parseado de boxscores).
//                                          Min 2 aperturas previas. Fallback:
//                                          ERA temporada PREVIA del mlb-pitcher-season.
//   (8) away_starter_era_last_5         — ídem para away starter.
//   (9) is_division_game                — equipos_mlb.division[home]==[away].
//   (10) home_stadium_park_factor       — equipos_mlb.park_factor[home_team_id].
//
// LEAKAGE GUARDS:
//   - Todas las stats de equipo se calculan SOLO con juegos cuyo dateStr <
//     game.dateStr de la fila objetivo. La comparación es estricta (no <=).
//   - ERA del starter se calcula SOLO con sus aperturas previas a game_date.
//     Fallback usa mlb-pitcher-season de season-1 (nunca de season actual ni
//     posterior, que sí leakearia).
//   - Starter ID: preferimos boxscore.teams.{home,away}.pitchers[0] (starter
//     CONFIRMADO del juego, post-lesiones/cambios) sobre el probable original
//     del schedule. Si el starter cambió por lesión, esto refleja la realidad.
//
// EDGE CASES (siguiendo el spec):
//   - Equipo con < 5 juegos previos en la temporada → win_rate_last_10 NULL.
//   - < 3 juegos previos en los últimos 30 días → runs_per_game/allowed NULL.
//   - Pitcher novato sin aperturas previas y sin season previa → ERA NULL.
//   - El modelo imputa NULLs con `means[]` en runtime (paridad con fútbol).
//
// USO en VPS (idempotente, reanudable vía ON CONFLICT DO UPDATE):
//   cd /apps/futbol && node --env-file=.env scripts/reenrich-baseball.js
//
// Args opcionales:
//   --limit=N        — solo procesar primeros N juegos (debug).
//   --concurrency=N  — default 5 (escrituras en paralelo).
// ────────────────────────────────────────────────────────────────────────

try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');

// ── Args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argVal = (name, def) => {
  const a = argv.find(s => s.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : def;
};
const LIMIT       = Number(argVal('limit', '0')) || 0;
const CONCURRENCY = Number(argVal('concurrency', '5')) || 5;
const PROGRESS_EVERY = 100;

// ── Tunables (mínimos para emitir cada feature) ────────────────────────
const MIN_WINRATE_GAMES  = 5;  // < 5 → NULL
const MIN_RUNS30_GAMES   = 3;  // < 3 → NULL
const MIN_STARTER_STARTS = 2;  // < 2 → fallback a ERA season-1

// ── Helpers ─────────────────────────────────────────────────────────────
function makePool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: Math.max(5, CONCURRENCY + 2),
  });
}

function parseInnings(ip) {
  if (ip == null) return 0;
  const n = Number(ip);
  if (!Number.isFinite(n)) return 0;
  const whole = Math.floor(n);
  const outs = Math.round((n - whole) * 10);
  return whole + outs / 3;
}

async function mapPool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx], idx); }
      catch (e) { console.warn(`  [warn] item ${idx} failed: ${e.message}`); }
    }
  }));
}

// Stream boxscores via cursor (cada uno ~180KB, no caben todos en memoria).
// Extrae starter id + IP + ER por juego y descarta el resto.
async function loadStartersByGame(pool) {
  const starterByGame = new Map(); // gamePk -> { home:{id,ip,er}, away:{id,ip,er} }
  const client = await pool.connect();
  let parsed = 0;
  try {
    await client.query('BEGIN');
    await client.query(
      `DECLARE bx_cur NO SCROLL CURSOR FOR
       SELECT ref_id, payload FROM raw_api_payloads
       WHERE endpoint='mlb-boxscore' AND sub_key='boxscore'`
    );
    while (true) {
      const { rows } = await client.query('FETCH 200 FROM bx_cur');
      if (rows.length === 0) break;
      for (const r of rows) {
        const box = r.payload;
        const findStarter = (team) => {
          if (!team) return null;
          // pitchers[] = array de pitcher IDs en orden de aparición → primero = starter.
          const pids = team.pitchers || [];
          if (pids.length === 0) return null;
          const sid = pids[0];
          const pdata = team.players?.[`ID${sid}`];
          if (!pdata) return { id: sid, ip: 0, er: 0 };
          const pit = pdata.stats?.pitching || {};
          return {
            id: sid,
            ip: parseInnings(pit.inningsPitched),
            er: Number(pit.earnedRuns) || 0,
          };
        };
        starterByGame.set(Number(r.ref_id), {
          home: findStarter(box.teams?.home),
          away: findStarter(box.teams?.away),
        });
        parsed++;
      }
      if (parsed % 1000 === 0) console.log(`  [boxscore-load] ${parsed} parsed`);
    }
    await client.query('CLOSE bx_cur');
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  console.log(`  [boxscore-load] DONE — ${parsed} boxscores parsed → ${starterByGame.size} games con starters`);
  return starterByGame;
}

// ── Cálculo de features ─────────────────────────────────────────────────
// teamHistory: team_id → array de { dateStr, season, won, runsScored, runsAllowed }
// ordenado ASC por dateStr. NUNCA incluye el juego objetivo (game.dateStr exclusivo).
function lastNBefore(history, beforeDate, season, n) {
  // history ya está ordenada ASC. Filtramos misma temporada y dateStr ESTRICTAMENTE
  // anterior, luego tomamos las N últimas.
  const eligible = [];
  for (const h of history) {
    if (h.season !== season) continue;
    if (h.dateStr >= beforeDate) break; // ordenada → corta temprano
    eligible.push(h);
  }
  return eligible.slice(-n);
}

function inLastDaysBefore(history, beforeDate, season, days) {
  const beforeTs = new Date(beforeDate + 'T00:00:00Z').getTime();
  const afterTs  = beforeTs - days * 86400000;
  const out = [];
  for (const h of history) {
    if (h.season !== season) continue;
    const t = new Date(h.dateStr + 'T00:00:00Z').getTime();
    if (t >= beforeTs) break; // ordenada
    if (t >= afterTs) out.push(h);
  }
  return out;
}

// ERA de últimas N aperturas del pitcher antes de beforeDate.
// pitcherStarts[pid] = [{ dateStr, ip, er }] ordenado ASC.
function eraFromLastStarts(starts, beforeDate, n) {
  const eligible = [];
  for (const s of starts) {
    if (s.dateStr >= beforeDate) break;
    eligible.push(s);
  }
  const recent = eligible.slice(-n);
  if (recent.length < MIN_STARTER_STARTS) return { era: null, n: recent.length };
  const totalIp = recent.reduce((a, s) => a + s.ip, 0);
  const totalEr = recent.reduce((a, s) => a + s.er, 0);
  if (totalIp <= 0) return { era: null, n: recent.length };
  return { era: (totalEr * 9) / totalIp, n: recent.length };
}

function computeFeatures(game, teamHistory, pitcherStarts, pitcherSeasonEra, teamMeta) {
  const homeMeta = teamMeta.get(game.homeId);
  const awayMeta = teamMeta.get(game.awayId);

  const homeHist = teamHistory.get(game.homeId) || [];
  const awayHist = teamHistory.get(game.awayId) || [];

  // (1, 4) win rate last 10
  const h10 = lastNBefore(homeHist, game.dateStr, game.season, 10);
  const a10 = lastNBefore(awayHist, game.dateStr, game.season, 10);
  const home_win_rate_last_10 = h10.length >= MIN_WINRATE_GAMES
    ? h10.filter(x => x.won).length / h10.length : null;
  const away_win_rate_last_10 = a10.length >= MIN_WINRATE_GAMES
    ? a10.filter(x => x.won).length / a10.length : null;

  // (2, 3, 5, 6) runs scored/allowed last 30 días
  const h30 = inLastDaysBefore(homeHist, game.dateStr, game.season, 30);
  const a30 = inLastDaysBefore(awayHist, game.dateStr, game.season, 30);
  const avg = (arr, k) => arr.reduce((a, x) => a + x[k], 0) / arr.length;
  const home_runs_per_game_last_30 = h30.length >= MIN_RUNS30_GAMES ? avg(h30, 'runsScored')  : null;
  const home_runs_allowed_last_30  = h30.length >= MIN_RUNS30_GAMES ? avg(h30, 'runsAllowed') : null;
  const away_runs_per_game_last_30 = a30.length >= MIN_RUNS30_GAMES ? avg(a30, 'runsScored')  : null;
  const away_runs_allowed_last_30  = a30.length >= MIN_RUNS30_GAMES ? avg(a30, 'runsAllowed') : null;

  // (7, 8) starter ERA last 5 — preferir aperturas reales; fallback a season-1.
  const eraFallback = (pid, season) => {
    if (!pid) return null;
    const v = pitcherSeasonEra.get(`${pid}|${season - 1}`);
    return v == null ? null : Number(v);
  };
  let home_starter_era_last_5 = null;
  if (game.homeStarterId) {
    const r = eraFromLastStarts(pitcherStarts.get(game.homeStarterId) || [], game.dateStr, 5);
    home_starter_era_last_5 = r.era != null ? r.era : eraFallback(game.homeStarterId, game.season);
  }
  let away_starter_era_last_5 = null;
  if (game.awayStarterId) {
    const r = eraFromLastStarts(pitcherStarts.get(game.awayStarterId) || [], game.dateStr, 5);
    away_starter_era_last_5 = r.era != null ? r.era : eraFallback(game.awayStarterId, game.season);
  }

  // (9) division game
  const is_division_game = !!(homeMeta?.division && awayMeta?.division && homeMeta.division === awayMeta.division);

  // (10) home stadium park factor
  const home_stadium_park_factor = homeMeta?.park_factor != null ? Number(homeMeta.park_factor) : 1.0;

  return {
    home_win_rate_last_10,
    home_runs_per_game_last_30,
    home_runs_allowed_last_30,
    away_win_rate_last_10,
    away_runs_per_game_last_30,
    away_runs_allowed_last_30,
    home_starter_era_last_5,
    away_starter_era_last_5,
    is_division_game,
    home_stadium_park_factor,
  };
}

// ── MAIN ────────────────────────────────────────────────────────────────
async function reenrichBaseball(opts = {}) {
  const { pool: extPool = null, limit = LIMIT, concurrency = CONCURRENCY } = opts;
  console.log('================================================');
  console.log('  reenrich-baseball — features point-in-time');
  console.log('================================================');
  console.log(`Concurrency: ${concurrency}${limit ? `  Limit: ${limit}` : ''}`);
  console.log('');

  const pool = extPool || makePool();
  const ownPool = !extPool;
  const tStart = Date.now();
  try {
    // 1) Equipos (division + park_factor).
    const { rows: equiposRows } = await pool.query(
      'SELECT team_id, division, park_factor FROM equipos_mlb'
    );
    const teamMeta = new Map(equiposRows.map(r => [Number(r.team_id), {
      division: r.division || null,
      park_factor: r.park_factor != null ? Number(r.park_factor) : 1.0,
    }]));
    console.log(`[load] equipos_mlb: ${teamMeta.size} equipos`);
    if (teamMeta.size < 30) {
      console.warn(`  ⚠ Esperaba ≥30 equipos en equipos_mlb. Corre seed-equipos-mlb.js primero.`);
    }

    // 2) Schedule Final games (game completo de la API).
    const { rows: scheduleRows } = await pool.query(
      `SELECT ref_id, season, payload FROM raw_api_payloads WHERE endpoint='mlb-schedule'`
    );
    console.log(`[load] mlb-schedule: ${scheduleRows.length} entries`);

    // 3) Pitcher-season (fallback ERA si no hay 2 aperturas previas).
    const { rows: psRows } = await pool.query(
      `SELECT ref_id, sub_key, payload FROM raw_api_payloads WHERE endpoint='mlb-pitcher-season'`
    );
    const pitcherSeasonEra = new Map();
    for (const r of psRows) {
      const era = r.payload?.era;
      if (era != null) pitcherSeasonEra.set(`${r.ref_id}|${r.sub_key}`, Number(era));
    }
    console.log(`[load] mlb-pitcher-season: ${psRows.length} entries (${pitcherSeasonEra.size} con era)`);

    // 4) Boxscores → starter (id + ip + er por juego) usando cursor.
    console.log('[load] mlb-boxscore: streaming via cursor…');
    const starterByGame = await loadStartersByGame(pool);

    // 5) Construir games[] desde schedule, completar starters desde boxscore (preferido).
    const games = [];
    for (const r of scheduleRows) {
      const g = r.payload;
      if (g.status?.detailedState !== 'Final') continue;
      const gamePk = Number(g.gamePk);
      const dateStr = (g.gameDate || g.officialDate || '').split('T')[0];
      if (!dateStr) continue;
      const homeId = g.teams?.home?.team?.id;
      const awayId = g.teams?.away?.team?.id;
      if (!homeId || !awayId) continue;
      const homeScore = g.teams?.home?.score;
      const awayScore = g.teams?.away?.score;
      if (homeScore == null || awayScore == null) continue;
      const season = Number(r.season) || new Date(dateStr + 'T12:00:00Z').getUTCFullYear();

      // Starter confirmado del boxscore (post-lesiones) > probable del schedule.
      const bx = starterByGame.get(gamePk);
      const homeStarterId = bx?.home?.id || g.teams?.home?.probablePitcher?.id || null;
      const awayStarterId = bx?.away?.id || g.teams?.away?.probablePitcher?.id || null;

      games.push({
        gamePk, dateStr, season, homeId, awayId,
        homeScore: Number(homeScore), awayScore: Number(awayScore),
        homeStarterId, awayStarterId,
        homeStarterIp: bx?.home?.ip || 0,
        homeStarterEr: bx?.home?.er || 0,
        awayStarterIp: bx?.away?.ip || 0,
        awayStarterEr: bx?.away?.er || 0,
      });
    }
    games.sort((a, b) => a.dateStr.localeCompare(b.dateStr) || a.gamePk - b.gamePk);
    console.log(`[build] ${games.length} games Final con datos completos`);

    // 6) Indexar histórico por equipo (ordenado ASC).
    const teamHistory = new Map();
    for (const g of games) {
      const homeRow = {
        dateStr: g.dateStr, season: g.season,
        won: g.homeScore > g.awayScore,
        runsScored: g.homeScore, runsAllowed: g.awayScore,
      };
      const awayRow = {
        dateStr: g.dateStr, season: g.season,
        won: g.awayScore > g.homeScore,
        runsScored: g.awayScore, runsAllowed: g.homeScore,
      };
      if (!teamHistory.has(g.homeId)) teamHistory.set(g.homeId, []);
      if (!teamHistory.has(g.awayId)) teamHistory.set(g.awayId, []);
      teamHistory.get(g.homeId).push(homeRow);
      teamHistory.get(g.awayId).push(awayRow);
    }
    // Ya están sorted (games iterados en orden).
    console.log(`[index] teamHistory: ${teamHistory.size} equipos`);

    // 7) Indexar aperturas por pitcher (solo starts CON IP > 0, ordenado ASC).
    const pitcherStarts = new Map();
    for (const g of games) {
      if (g.homeStarterId && g.homeStarterIp > 0) {
        if (!pitcherStarts.has(g.homeStarterId)) pitcherStarts.set(g.homeStarterId, []);
        pitcherStarts.get(g.homeStarterId).push({ dateStr: g.dateStr, ip: g.homeStarterIp, er: g.homeStarterEr });
      }
      if (g.awayStarterId && g.awayStarterIp > 0) {
        if (!pitcherStarts.has(g.awayStarterId)) pitcherStarts.set(g.awayStarterId, []);
        pitcherStarts.get(g.awayStarterId).push({ dateStr: g.dateStr, ip: g.awayStarterIp, er: g.awayStarterEr });
      }
    }
    console.log(`[index] pitcherStarts: ${pitcherStarts.size} pitchers`);

    // 8) Calcular features + UPSERT en features_baseball.
    const target = limit ? games.slice(0, limit) : games;
    console.log(`\n[compute] procesando ${target.length} games…`);
    const t0 = Date.now();
    let inserted = 0, updated = 0, skippedNoTeam = 0, nullCounts = {
      win10: 0, runs30: 0, era5: 0,
    };

    await mapPool(target, concurrency, async (g, idx) => {
      if (!teamMeta.has(g.homeId) || !teamMeta.has(g.awayId)) {
        skippedNoTeam++;
        return;
      }
      const f = computeFeatures(g, teamHistory, pitcherStarts, pitcherSeasonEra, teamMeta);

      // Tracking de NULLs (audit calidad).
      if (f.home_win_rate_last_10 == null || f.away_win_rate_last_10 == null) nullCounts.win10++;
      if (f.home_runs_per_game_last_30 == null || f.away_runs_per_game_last_30 == null) nullCounts.runs30++;
      if (f.home_starter_era_last_5 == null || f.away_starter_era_last_5 == null) nullCounts.era5++;

      const res = await pool.query(
        `INSERT INTO features_baseball (
          fixture_id, game_date, home_team_id, away_team_id,
          home_win_rate_last_10, home_runs_per_game_last_30, home_runs_allowed_last_30,
          away_win_rate_last_10, away_runs_per_game_last_30, away_runs_allowed_last_30,
          home_starter_era_last_5, away_starter_era_last_5,
          is_division_game, home_stadium_park_factor,
          updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
        ON CONFLICT (fixture_id) DO UPDATE SET
          game_date                  = EXCLUDED.game_date,
          home_team_id               = EXCLUDED.home_team_id,
          away_team_id               = EXCLUDED.away_team_id,
          home_win_rate_last_10      = EXCLUDED.home_win_rate_last_10,
          home_runs_per_game_last_30 = EXCLUDED.home_runs_per_game_last_30,
          home_runs_allowed_last_30  = EXCLUDED.home_runs_allowed_last_30,
          away_win_rate_last_10      = EXCLUDED.away_win_rate_last_10,
          away_runs_per_game_last_30 = EXCLUDED.away_runs_per_game_last_30,
          away_runs_allowed_last_30  = EXCLUDED.away_runs_allowed_last_30,
          home_starter_era_last_5    = EXCLUDED.home_starter_era_last_5,
          away_starter_era_last_5    = EXCLUDED.away_starter_era_last_5,
          is_division_game           = EXCLUDED.is_division_game,
          home_stadium_park_factor   = EXCLUDED.home_stadium_park_factor,
          updated_at                 = NOW()
        RETURNING (xmax = 0) AS is_insert`,
        [
          g.gamePk, g.dateStr, g.homeId, g.awayId,
          f.home_win_rate_last_10, f.home_runs_per_game_last_30, f.home_runs_allowed_last_30,
          f.away_win_rate_last_10, f.away_runs_per_game_last_30, f.away_runs_allowed_last_30,
          f.home_starter_era_last_5, f.away_starter_era_last_5,
          f.is_division_game, f.home_stadium_park_factor,
        ]
      );
      if (res.rows[0]?.is_insert) inserted++; else updated++;

      if ((idx + 1) % PROGRESS_EVERY === 0) {
        const el = ((Date.now() - t0) / 1000).toFixed(0);
        console.log(`  [${idx + 1}/${target.length}] inserted=${inserted} updated=${updated} skip=${skippedNoTeam} | ${el}s`);
      }
    });

    const elapsed = ((Date.now() - tStart) / 1000).toFixed(0);
    console.log('');
    console.log('──────────────────────────────────────────────');
    console.log('RESUMEN');
    console.log(`  Games procesados:    ${target.length}`);
    console.log(`  Inserted:            ${inserted}`);
    console.log(`  Updated:             ${updated}`);
    console.log(`  Skipped (sin team):  ${skippedNoTeam}`);
    console.log(`  NULL win10 alguno:   ${nullCounts.win10} (${((nullCounts.win10 / Math.max(target.length, 1)) * 100).toFixed(1)}%)`);
    console.log(`  NULL runs30 alguno:  ${nullCounts.runs30} (${((nullCounts.runs30 / Math.max(target.length, 1)) * 100).toFixed(1)}%)`);
    console.log(`  NULL era5 alguno:    ${nullCounts.era5} (${((nullCounts.era5 / Math.max(target.length, 1)) * 100).toFixed(1)}%)`);

    // Audit final en BD.
    const { rows: counts } = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE home_win_rate_last_10 IS NOT NULL AND away_win_rate_last_10 IS NOT NULL)::int AS with_win10,
         COUNT(*) FILTER (WHERE home_starter_era_last_5 IS NOT NULL AND away_starter_era_last_5 IS NOT NULL)::int AS with_era,
         COUNT(*) FILTER (WHERE is_division_game)::int AS div_games,
         AVG(home_stadium_park_factor)::numeric(4,3) AS avg_pf
       FROM features_baseball`
    );
    const c = counts[0];
    console.log('');
    console.log('features_baseball (tabla):');
    console.log(`  Total filas:         ${c.total}`);
    console.log(`  Con win10 (h+a):     ${c.with_win10} (${((c.with_win10 / Math.max(c.total, 1)) * 100).toFixed(1)}%)`);
    console.log(`  Con ERA (h+a):       ${c.with_era} (${((c.with_era / Math.max(c.total, 1)) * 100).toFixed(1)}%)`);
    console.log(`  División games:      ${c.div_games}`);
    console.log(`  Park factor avg:     ${c.avg_pf}`);
    console.log('──────────────────────────────────────────────');
    console.log(`✓ DONE in ${elapsed}s`);
    return { ok: true, processed: target.length, inserted, updated, skippedNoTeam, totalInTable: c.total };
  } catch (e) {
    console.error('\nFATAL:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
    throw e;
  } finally {
    if (ownPool) await pool.end();
  }
}

if (require.main === module) {
  reenrichBaseball().catch(() => process.exit(1));
}

module.exports = { reenrichBaseball };
