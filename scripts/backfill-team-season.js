/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Backfill PERMANENTE de la temporada completa por equipo → team_season_history.
// Da el ADN real (30-38 partidos/equipo en ligas domésticas), no los ~5 que
// aparecen en match_predictions.
//
// MODOS:
//   (defecto)  estimación: cuenta equipos únicos y estima llamadas. NO gasta API.
//   --run      ejecuta el backfill.
//   --resume   con --run, salta equipos que ya tienen filas de la temporada.
//   --season=2025 (defecto), --concurrency=6
//
//   node --env-file=.env scripts/backfill-team-season.js            # estimar
//   node --env-file=.env scripts/backfill-team-season.js --run      # ejecutar
// ────────────────────────────────────────────────────────────────────────
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }));
const SEASON = Number(args.season) || 2025;
const CONCURRENCY = Number(args.concurrency) || 6;
const RUN = !!args.run;
const RESUME = !!args.resume;
const SEASON_START = `${SEASON}-07-01`;

const API_HOST = 'v3.football.api-sports.io';
const API_KEY = process.env.FOOTBALL_API_KEY;
const FINISHED = new Set(['FT', 'AET', 'PEN']);

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

let apiCalls = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function apiGet(path, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      apiCalls++;
      const res = await fetch(`https://${API_HOST}${path}`, { headers: { 'x-apisports-key': API_KEY }, signal: AbortSignal.timeout(20000) });
      if (res.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (!res.ok) return [];
      const json = await res.json();
      if (json.errors && Object.keys(json.errors).length > 0) return [];
      return json.response || [];
    } catch (e) { if (i === tries - 1) { console.warn(`  api fail ${path}: ${e.message}`); return []; } await sleep(1000 * (i + 1)); }
  }
  return [];
}

const statsCache = new Map();
async function getStats(fid) {
  if (statsCache.has(fid)) return statsCache.get(fid);
  const st = await apiGet(`/fixtures/statistics?fixture=${fid}`);
  statsCache.set(fid, st);
  return st;
}
function statVal(stats, teamId, type, pct = false) {
  const ts = (stats || []).find(s => s.team?.id === teamId);
  const v = (ts?.statistics || []).find(s => s.type === type)?.value;
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

async function distinctTeams() {
  const { rows } = await pgPool.query(
    `SELECT DISTINCT team_id FROM (
       SELECT (home_team->>'id')::int AS team_id FROM match_predictions WHERE kickoff >= $1
       UNION
       SELECT (away_team->>'id')::int AS team_id FROM match_predictions WHERE kickoff >= $1
     ) t WHERE team_id IS NOT NULL`,
    [SEASON_START]
  );
  return rows.map(r => r.team_id);
}

async function processTeam(teamId) {
  const fixtures = await apiGet(`/fixtures?team=${teamId}&season=${SEASON}`);
  const finished = (fixtures || []).filter(f => FINISHED.has(f.fixture?.status?.short) && f.goals?.home != null);
  let saved = 0;
  for (const f of finished) {
    const isHome = f.teams?.home?.id === teamId;
    const oppId = isHome ? f.teams?.away?.id : f.teams?.home?.id;
    const gf = isHome ? f.goals.home : f.goals.away;
    const ga = isHome ? f.goals.away : f.goals.home;
    const stats = await getStats(f.fixture.id);
    const hId = f.teams?.home?.id, aId = f.teams?.away?.id;
    const me = isHome ? hId : aId, opp = isHome ? aId : hId;
    const yc = statVal(stats, me, 'Yellow Cards') || 0;
    const rc = statVal(stats, me, 'Red Cards') || 0;
    const row = {
      team_id: teamId, season: SEASON, fixture_id: f.fixture.id,
      date: f.fixture.date, league_id: f.league?.id,
      venue: isHome ? 'home' : 'away', opponent_id: oppId,
      result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
      goals_for: gf, goals_against: ga,
      corners_for: statVal(stats, me, 'Corner Kicks'),
      corners_against: statVal(stats, opp, 'Corner Kicks'),
      cards_for: yc + rc,
      shots_for: statVal(stats, me, 'Total Shots'),
      shots_against: statVal(stats, opp, 'Total Shots'),
      sot_for: statVal(stats, me, 'Shots on Goal'),
      fouls_for: statVal(stats, me, 'Fouls'),
      possession_for: statVal(stats, me, 'Ball Possession'),
      xg_for: statVal(stats, me, 'expected_goals'),
      xg_against: statVal(stats, opp, 'expected_goals'),
    };
    await pgPool.query(
      `INSERT INTO team_season_history (sport,team_id,season,fixture_id,date,league_id,venue,opponent_id,result,goals_for,goals_against,corners_for,corners_against,cards_for,shots_for,shots_against,sot_for,fouls_for,possession_for,xg_for,xg_against,updated_at)
       VALUES ('football',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
       ON CONFLICT (team_id,fixture_id) DO UPDATE SET
         result=EXCLUDED.result, goals_for=EXCLUDED.goals_for, goals_against=EXCLUDED.goals_against,
         corners_for=EXCLUDED.corners_for, corners_against=EXCLUDED.corners_against, cards_for=EXCLUDED.cards_for,
         shots_for=EXCLUDED.shots_for, shots_against=EXCLUDED.shots_against, sot_for=EXCLUDED.sot_for,
         fouls_for=EXCLUDED.fouls_for, possession_for=EXCLUDED.possession_for, xg_for=EXCLUDED.xg_for, xg_against=EXCLUDED.xg_against, updated_at=NOW()`,
      [row.team_id, row.season, row.fixture_id, row.date, row.league_id, row.venue, row.opponent_id, row.result, row.goals_for, row.goals_against, row.corners_for, row.corners_against, row.cards_for, row.shots_for, row.shots_against, row.sot_for, row.fouls_for, row.possession_for, row.xg_for, row.xg_against]
    );
    saved++;
  }
  return saved;
}

async function mapPool(items, limit, fn) {
  let i = 0; const ret = [];
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { ret[idx] = await fn(items[idx]); } catch (e) { ret[idx] = { error: e.message }; } }
  }));
  return ret;
}

(async () => {
  let teams = await distinctTeams();
  console.log(`\nEquipos únicos en match_predictions (temporada ≥ ${SEASON_START}): ${teams.length}`);

  if (!RUN) {
    const AVG_FIX = 34; // partidos por equipo-temporada (estimación)
    const seasonCalls = teams.length;                 // 1 /fixtures?team&season por equipo
    const statsCalls = Math.round(teams.length * AVG_FIX / 2); // ~mitad por dedup (cada partido 2 equipos)
    console.log(`\n── ESTIMACIÓN (no se gastó API) ──`);
    console.log(`  Llamadas /fixtures?team&season : ${seasonCalls}`);
    console.log(`  Llamadas /fixtures/statistics  : ~${statsCalls} (≈${teams.length}×${AVG_FIX}/2 por dedup)`);
    console.log(`  TOTAL estimado                 : ~${seasonCalls + statsCalls} llamadas`);
    console.log(`  Tiempo aprox (concurrency ${CONCURRENCY})    : ~${Math.round((seasonCalls + statsCalls) / 350)}-${Math.round((seasonCalls + statsCalls) / 150)} min (según cap por minuto)`);
    console.log(`\n  Para ejecutar:  node --env-file=.env scripts/backfill-team-season.js --run\n`);
    await pgPool.end();
    return;
  }

  if (!API_KEY) { console.error('FATAL: FOOTBALL_API_KEY no está en el env'); process.exit(1); }

  if (RESUME) {
    const { rows } = await pgPool.query(`SELECT DISTINCT team_id FROM team_season_history WHERE season=$1`, [SEASON]);
    const done = new Set(rows.map(r => r.team_id));
    const before = teams.length;
    teams = teams.filter(t => !done.has(t));
    console.log(`--resume: ${before - teams.length} equipos ya hechos, faltan ${teams.length}`);
  }

  let totalSaved = 0, processed = 0;
  await mapPool(teams, CONCURRENCY, async (teamId) => {
    const saved = await processTeam(teamId);
    totalSaved += saved; processed++;
    if (processed % 25 === 0) console.log(`  ${processed}/${teams.length} equipos · ${totalSaved} filas · apiCalls=${apiCalls}`);
    return saved;
  });

  console.log(`\n✓ team_season_history poblada: ${totalSaved} filas de ${teams.length} equipos. apiCalls=${apiCalls}`);
  await pgPool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
