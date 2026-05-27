/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Motor de captura CRUDA total (Camino B). Lo usan el CLI
// (scripts/backfill-raw-total.js) y el job del worker (cron 4am, tanda 2).
//
// Guarda en raw_api_payloads el payload COMPLETO de cada endpoint, sin filtrar:
//   por equipo:   teams, teams/statistics (×liga), players/squads, coachs,
//                 injuries?team&season, transfers, venues, players?team&season (paginado)
//   por fixture:  fixtures (detalle), fixtures/statistics, fixtures/events,
//                 fixtures/lineups, fixtures/players, predictions, injuries?fixture
//                 (odds opcional --with-odds; purgadas en históricos)
//
// IDEMPOTENTE: antes de cada llamada comprueba si el payload ya existe → la
// tanda 2 no repite la 1, y los fixtures compartidos entre equipos se capturan
// una sola vez. Resumible ante cortes.
//
// --half=1|2 parte los 620 equipos balanceadamente (orden por id, mitades).
// Excluye juveniles (isYouthTeam) y partidos contra rival juvenil.
// ────────────────────────────────────────────────────────────────────────

const { Pool } = require('pg');
let isYouthTeam;
try { ({ isYouthTeam } = require('./leagues')); } catch { isYouthTeam = () => false; }

const API_HOST = 'v3.football.api-sports.io';
const FINISHED = new Set(['FT', 'AET', 'PEN']);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makePool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 5,
  });
}

function makeApi(counter) {
  const key = process.env.FOOTBALL_API_KEY;
  return async function apiGet(path, tries = 3) {
    for (let i = 0; i < tries; i++) {
      try {
        counter.calls++;
        const res = await fetch(`https://${API_HOST}${path}`, { headers: { 'x-apisports-key': key }, signal: AbortSignal.timeout(20000) });
        if (res.status === 429) { await sleep(2000 * (i + 1)); continue; }
        if (!res.ok) return { __http: res.status, response: [] };
        return await res.json(); // payload CRUDO completo (response + paging + parameters)
      } catch (e) { if (i === tries - 1) return { __error: e.message, response: [] }; await sleep(1000 * (i + 1)); }
    }
    return { response: [] };
  };
}

// Guarda un valor ya obtenido (sin llamar a la API). Idempotente.
async function saveValue(pool, { endpoint, refType, refId, season, subKey = '', payload }) {
  await pool.query(
    `INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW()) ON CONFLICT (endpoint, ref_id, sub_key) DO NOTHING`,
    [endpoint, refType, refId, season ?? null, subKey, JSON.stringify(payload)]
  );
}

// Captura un endpoint si no existe ya (chequea ANTES de llamar → ahorra cuota).
async function captureOnce(pool, apiGet, counter, { endpoint, refType, refId, season, subKey = '', path }) {
  const { rows } = await pool.query(
    `SELECT 1 FROM raw_api_payloads WHERE endpoint=$1 AND ref_id=$2 AND sub_key=$3`,
    [endpoint, refId, subKey]
  );
  if (rows.length) { counter.skipped++; return; }
  const payload = await apiGet(path);
  await saveValue(pool, { endpoint, refType, refId, season, subKey, payload });
  counter.saved++;
}

async function getTeamsForHalf(pool, half, season) {
  const seasonStart = `${season}-07-01`;
  const { rows } = await pool.query(
    `SELECT (home_team->>'id')::int AS id, home_team->>'name' AS name FROM match_predictions WHERE kickoff >= $1 AND home_team->>'id' IS NOT NULL
     UNION
     SELECT (away_team->>'id')::int AS id, away_team->>'name' AS name FROM match_predictions WHERE kickoff >= $1 AND away_team->>'id' IS NOT NULL`,
    [seasonStart]
  );
  const byId = new Map();
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r.name);
  // Excluir juveniles, ordenar por id, partir en mitades balanceadas.
  const ids = [...byId.entries()].filter(([, name]) => !isYouthTeam(name)).map(([id]) => id).sort((a, b) => a - b);
  if (!half) return ids;
  const mid = Math.ceil(ids.length / 2);
  return half === 1 ? ids.slice(0, mid) : ids.slice(mid);
}

async function mapPool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { await fn(items[idx], idx); } catch (e) { console.warn('  team fail:', e.message); } }
  }));
}

async function processTeam(pool, apiGet, counter, opts, teamId) {
  const { season, withOdds } = opts;
  // 1) Fixtures de la temporada (1 llamada) → guarda el detalle de cada fixture.
  const fxResp = await apiGet(`/fixtures?team=${teamId}&season=${season}`);
  counter.callsTeamFixtures++;
  const fixtures = Array.isArray(fxResp?.response) ? fxResp.response : [];
  const leagues = new Set();
  for (const f of fixtures) {
    if (f.league?.id) leagues.add(f.league.id);
    if (f.fixture?.id) await saveValue(pool, { endpoint: 'fixtures', refType: 'fixture', refId: f.fixture.id, season, payload: f });
  }

  // 2) Endpoints por equipo (idempotentes).
  await captureOnce(pool, apiGet, counter, { endpoint: 'teams', refType: 'team', refId: teamId, season, path: `/teams?id=${teamId}` });
  await captureOnce(pool, apiGet, counter, { endpoint: 'players/squads', refType: 'team', refId: teamId, season, path: `/players/squads?team=${teamId}` });
  await captureOnce(pool, apiGet, counter, { endpoint: 'coachs', refType: 'team', refId: teamId, season, path: `/coachs?team=${teamId}` });
  await captureOnce(pool, apiGet, counter, { endpoint: 'injuries', refType: 'team', refId: teamId, season, subKey: `team:${season}`, path: `/injuries?team=${teamId}&season=${season}` });
  await captureOnce(pool, apiGet, counter, { endpoint: 'transfers', refType: 'team', refId: teamId, season, path: `/transfers?team=${teamId}` });
  // venue: del primer fixture donde el equipo es local.
  const venueId = fixtures.find(f => f.teams?.home?.id === teamId)?.fixture?.venue?.id;
  if (venueId) await captureOnce(pool, apiGet, counter, { endpoint: 'venues', refType: 'team', refId: teamId, season, subKey: `v:${venueId}`, path: `/venues?id=${venueId}` });
  // teams/statistics por cada liga jugada.
  for (const lid of leagues) {
    await captureOnce(pool, apiGet, counter, { endpoint: 'teams/statistics', refType: 'team', refId: teamId, season, subKey: `l:${lid}`, path: `/teams/statistics?team=${teamId}&league=${lid}&season=${season}` });
  }
  // players?team&season (stats de temporada por jugador, paginado, cap 5 págs).
  for (let page = 1; page <= 5; page++) {
    const { rows } = await pool.query(`SELECT 1 FROM raw_api_payloads WHERE endpoint='players' AND ref_id=$1 AND sub_key=$2`, [teamId, `p:${page}`]);
    if (rows.length) { counter.skipped++; continue; }
    const resp = await apiGet(`/players?team=${teamId}&season=${season}&page=${page}`);
    await saveValue(pool, { endpoint: 'players', refType: 'team', refId: teamId, season, subKey: `p:${page}`, payload: resp });
    counter.saved++;
    const total = resp?.paging?.total || 1;
    if (page >= total) break;
  }

  // 3) Endpoints por fixture finalizado (idempotentes; salta rival juvenil).
  for (const f of fixtures) {
    if (!FINISHED.has(f.fixture?.status?.short)) continue;
    const fid = f.fixture?.id; if (!fid) continue;
    const oppName = f.teams?.home?.id === teamId ? f.teams?.away?.name : f.teams?.home?.name;
    if (isYouthTeam(oppName)) continue;
    const ep = [
      ['fixtures/statistics', `/fixtures/statistics?fixture=${fid}`],
      ['fixtures/events', `/fixtures/events?fixture=${fid}`],
      ['fixtures/lineups', `/fixtures/lineups?fixture=${fid}`],
      ['fixtures/players', `/fixtures/players?fixture=${fid}`],
      ['predictions', `/predictions?fixture=${fid}`],
      ['injuries', `/injuries?fixture=${fid}`],
    ];
    if (withOdds) ep.push(['odds', `/odds?fixture=${fid}`]);
    for (const [endpoint, path] of ep) {
      const subKey = endpoint === 'injuries' ? `fx:${fid}` : '';
      await captureOnce(pool, apiGet, counter, { endpoint, refType: 'fixture', refId: fid, season, subKey, path });
    }
  }
  counter.teamsDone++;
}

async function runRawBackfill(opts = {}) {
  const { half = null, run = false, withOdds = false, season = 2025, concurrency = 5 } = opts;
  const pool = makePool();
  const counter = { calls: 0, callsTeamFixtures: 0, saved: 0, skipped: 0, teamsDone: 0 };
  try {
    const teams = await getTeamsForHalf(pool, half, season);
    console.log(`\nCaptura cruda — temporada ${season} · half=${half || 'todos'} · equipos=${teams.length}`);

    if (!run) {
      const AVG_FIX = 30, FX_EP = withOdds ? 7 : 6, TEAM_EP = 10;
      const teamLevel = teams.length * TEAM_EP;
      const fixtureLevel = Math.round(teams.length * AVG_FIX * FX_EP / 1.5); // /1.5 ≈ dedup intra-half
      const total = teamLevel + fixtureLevel + teams.length; // +fixtures list
      console.log(`── ESTIMACIÓN (no gasta API) ──`);
      console.log(`  por equipo (~${TEAM_EP} endpoints): ~${teamLevel}`);
      console.log(`  por fixture (~${AVG_FIX}×${FX_EP}, dedup): ~${fixtureLevel}`);
      console.log(`  fixtures-temporada:                ~${teams.length}`);
      console.log(`  TOTAL estimado: ~${total} llamadas · ~${Math.round(total / 400)}-${Math.round(total / 180)} min (según cap/min)`);
      console.log(`  (idempotente: lo ya capturado por la otra tanda no se repite)\n`);
      await pool.end();
      return { estimate: true, teams: teams.length, estCalls: total };
    }

    if (!process.env.FOOTBALL_API_KEY) throw new Error('FOOTBALL_API_KEY no está en el env');
    const apiGet = makeApi(counter);
    const t0 = Date.now();
    await mapPool(teams, concurrency, async (teamId, idx) => {
      await processTeam(pool, apiGet, counter, { season, withOdds }, teamId);
      if (counter.teamsDone % 20 === 0) {
        console.log(`  ${counter.teamsDone}/${teams.length} equipos · calls=${counter.calls} · guardados=${counter.saved} · skip=${counter.skipped} · ${Math.round((Date.now() - t0) / 60000)}min`);
      }
    });
    console.log(`\n✓ Tanda half=${half} completa: ${counter.teamsDone} equipos · ${counter.calls} llamadas · ${counter.saved} payloads nuevos · ${counter.skipped} ya existían.`);
    return { ok: true, ...counter };
  } finally {
    await pool.end();
  }
}

module.exports = { runRawBackfill, getTeamsForHalf };
