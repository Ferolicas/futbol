/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Paso 2 — Re-enriquece features_full de los 1246 match_predictions con datos
// POINT-IN-TIME reales de raw_api_payloads (forma L5 con xG/posesión reales,
// tabla reconstruida, lesionados del fixture), reemplazando la versión del
// backfill anterior. Usa el buildFeatureSnapshot existente (sin cambios).
//
//   node --env-file=.env scripts/reenrich-features.js [--limit=N]
//
// También exportado como reenrichFeatures({ pool?, limit?, fixtureIds? }) para
// el cron nocturno de retrain (futbol-retrain). Con fixtureIds re-enriquece solo
// esos partidos (incremental); sin él, todos.
// ────────────────────────────────────────────────────────────────────────
const { Pool } = require('pg');
const { buildFeatureSnapshot } = require('../lib/feature-snapshot');
const { statVal, FINISHED } = require('../lib/adn');

function makePool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 5,
  });
}

// _enriched con la forma EXACTA que espera buildFeatureSnapshot (mismo shape que
// enrichLastFiveMatches): valores {home,away} + isHome.
function enrichItem(f, st, teamId) {
  const homeId = f.teams?.home?.id, awayId = f.teams?.away?.id;
  const isHome = teamId === homeId;
  const gf = isHome ? f.goals?.home : f.goals?.away;
  const ga = isHome ? f.goals?.away : f.goals?.home;
  const result = (gf == null || ga == null) ? 'D' : gf > ga ? 'W' : gf < ga ? 'L' : 'D';
  const pair = (type) => ({ home: statVal(st, homeId, type), away: statVal(st, awayId, type) });
  return {
    fixture: { date: f.fixture?.date },
    goals: f.goals,
    _enriched: {
      isHome, result, goalsFor: gf, goalsAgainst: ga,
      corners: pair('Corner Kicks'),
      yellowCards: pair('Yellow Cards'),
      redCards: pair('Red Cards'),
      shots: pair('Total Shots'),
      sot: pair('Shots on Goal'),
      possession: pair('Ball Possession'),
      xg: pair('expected_goals'),
    },
  };
}

function reconstructTable(leagueFixtures, beforeMs) {
  const t = {};
  const ens = (id) => (t[id] = t[id] || { played: 0, pts: 0, gd: 0 });
  for (const f of leagueFixtures) {
    if (new Date(f.fixture?.date).getTime() >= beforeMs) continue;
    if (!FINISHED.has(f.fixture?.status?.short)) continue;
    const hg = f.score?.fulltime?.home ?? f.goals?.home, ag = f.score?.fulltime?.away ?? f.goals?.away;
    if (hg == null || ag == null) continue;
    const h = ens(f.teams.home.id), a = ens(f.teams.away.id);
    h.played++; a.played++; h.gd += hg - ag; a.gd += ag - hg;
    if (hg > ag) h.pts += 3; else if (hg < ag) a.pts += 3; else { h.pts++; a.pts++; }
  }
  const arr = Object.entries(t).sort((x, y) => y[1].pts - x[1].pts || y[1].gd - x[1].gd);
  const rank = {}; arr.forEach(([id], i) => { rank[id] = i + 1; });
  return rank;
}

async function reenrichFeatures(opts = {}) {
  const { pool: extPool = null, limit = null, fixtureIds = null } = opts;
  const pool = extPool || makePool();
  const ownPool = !extPool;
  try {
  console.log('\nCargando crudos…');
  const { rows: fxRows } = await pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures'`);
  const { rows: stRows } = await pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures/statistics'`);
  const { rows: injRows } = await pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='injuries' AND sub_key LIKE 'fx:%'`);
  const fixById = new Map(fxRows.map(r => [Number(r.ref_id), r.payload]));
  const stById = new Map(stRows.map(r => [Number(r.ref_id), r.payload]));
  const injById = new Map(injRows.map(r => [Number(r.ref_id), r.payload]));
  // Índices: por equipo y por liga.
  const byTeam = new Map(), byLeague = new Map();
  for (const r of fxRows) {
    const f = r.payload;
    if (f.league?.id) { if (!byLeague.has(f.league.id)) byLeague.set(f.league.id, []); byLeague.get(f.league.id).push(f); }
    for (const tid of [f.teams?.home?.id, f.teams?.away?.id]) { if (!tid) continue; if (!byTeam.has(tid)) byTeam.set(tid, []); byTeam.get(tid).push(f); }
  }
  for (const arr of byTeam.values()) arr.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
  console.log(`  fixtures=${fxRows.length} · stats=${stRows.length} · injuries=${injById.size} · equipos=${byTeam.size}`);

  let q = `SELECT fixture_id, home_team, away_team, kickoff, league_id FROM match_predictions`;
  const qParams = [];
  if (Array.isArray(fixtureIds) && fixtureIds.length) { q += ` WHERE fixture_id = ANY($1)`; qParams.push(fixtureIds); }
  q += ` ORDER BY kickoff`;
  if (limit) q += ` LIMIT ${Number(limit)}`;
  const { rows: preds } = await pool.query(q, qParams);
  console.log(`Partidos a re-enriquecer: ${preds.length}`);

  const last5 = (teamId, beforeMs) => (byTeam.get(teamId) || [])
    .filter(f => new Date(f.fixture.date).getTime() < beforeMs && FINISHED.has(f.fixture?.status?.short))
    .slice(-5).reverse()
    .map(f => enrichItem(f, stById.get(Number(f.fixture.id)) || null, teamId));

  let done = 0, failed = 0;
  for (const p of preds) {
    try {
      const homeId = p.home_team?.id, awayId = p.away_team?.id;
      const beforeMs = new Date(p.kickoff).getTime();
      const own = fixById.get(Number(p.fixture_id)) || {};
      const table = reconstructTable(byLeague.get(p.league_id) || [], beforeMs);
      const injPayload = injById.get(Number(p.fixture_id));
      const injuries = (injPayload?.response || injPayload || []);
      const analysis = {
        homeId, awayId, homeTeam: p.home_team?.name, awayTeam: p.away_team?.name,
        kickoff: p.kickoff, leagueId: p.league_id, league: own.league?.name,
        leagueCountry: own.league?.country, leagueRound: own.league?.round || null,
        homeLastFive: last5(homeId, beforeMs), awayLastFive: last5(awayId, beforeMs),
        odds: {}, // odds históricas ausentes; el feature entra en vivo
        homePosition: table[homeId] ?? null, awayPosition: table[awayId] ?? null,
        filteredInjuries: Array.isArray(injuries) ? injuries : [],
        playerHighlights: null, h2h: [],
        standingsContext: null,
        refereeStats: own.fixture?.referee ? { name: own.fixture.referee } : null,
      };
      const features = buildFeatureSnapshot(analysis, {});
      features._source = 'reenrich-raw';
      await pool.query(`UPDATE match_predictions SET features_full = $1::jsonb WHERE fixture_id = $2`, [JSON.stringify(features), p.fixture_id]);
      done++;
      if (done % 100 === 0) console.log(`  ${done}/${preds.length}`);
    } catch (e) { failed++; console.warn(`  fail fid=${p.fixture_id}: ${e.message}`); }
  }
  console.log(`\n✓ Re-enriquecidos: ${done}/${preds.length} (fallos: ${failed}). features_full ahora con datos crudos point-in-time.`);
  return { done, failed, total: preds.length };
  } finally {
    if (ownPool) await pool.end();
  }
}

module.exports = { reenrichFeatures };

if (require.main === module) {
  try { require('dotenv').config({ path: '.env.local' }); } catch {}
  try { require('dotenv').config({ path: '.env' }); } catch {}
  const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }));
  reenrichFeatures({ limit: args.limit ? Number(args.limit) : null })
    .then(() => process.exit(0))
    .catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
