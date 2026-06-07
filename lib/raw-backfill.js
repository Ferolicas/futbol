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
  // teams/statistics por cada liga jugada. sub_key con season → multi-temporada
  // sin colisión de PK (clave para selecciones capturadas en varios años).
  for (const lid of leagues) {
    await captureOnce(pool, apiGet, counter, { endpoint: 'teams/statistics', refType: 'team', refId: teamId, season, subKey: `s:${season}:l:${lid}`, path: `/teams/statistics?team=${teamId}&league=${lid}&season=${season}` });
  }
  // players?team&season (stats de temporada por jugador, paginado, cap 5 págs).
  for (let page = 1; page <= 5; page++) {
    const sk = `s:${season}:p:${page}`;
    const { rows } = await pool.query(`SELECT 1 FROM raw_api_payloads WHERE endpoint='players' AND ref_id=$1 AND sub_key=$2`, [teamId, sk]);
    if (rows.length) { counter.skipped++; continue; }
    const resp = await apiGet(`/players?team=${teamId}&season=${season}&page=${page}`);
    await saveValue(pool, { endpoint: 'players', refType: 'team', refId: teamId, season, subKey: sk, payload: resp });
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

// ── Modo "por ligas": descubre equipos vía /teams?league&season y captura su
//    historial igual que los clubes. Para SELECCIONES (national:true) del
//    Mundial y para ligas dormidas con clubes (Portugal, K-League, AFC CL...).

// Ligas de selecciones para el ADN del Mundial (sin juveniles, ya filtrados).
const SELECCIONES_LEAGUES = [32, 33, 34, 35, 36, 37, 5, 10, 4, 9, 6, 7];

// Temporada vigente de una liga (current=true, o la más reciente).
async function resolveSeason(apiGet, leagueId, override) {
  if (override) return override;
  const resp = await apiGet(`/leagues?id=${leagueId}`);
  const seasons = resp?.response?.[0]?.seasons || [];
  const cur = seasons.find(s => s.current) || seasons[seasons.length - 1];
  return cur?.year || 2025;
}

// Equipos de una liga-temporada. nationalOnly → solo selecciones. Excluye juveniles.
async function teamsFromLeague(apiGet, leagueId, season, nationalOnly) {
  const resp = await apiGet(`/teams?league=${leagueId}&season=${season}`);
  const out = [];
  for (const t of (resp?.response || [])) {
    const team = t.team || {};
    if (nationalOnly && !team.national) continue;
    if (isYouthTeam(team.name)) continue;
    if (team.id) out.push(team.id);
  }
  return out;
}

async function runRawBackfillLeagues(opts = {}) {
  const {
    leagues = SELECCIONES_LEAGUES, nationalOnly = true,
    run = false, withOdds = false, concurrency = 5,
    discoverSeason = null,   // temporada para /teams?league (null = auto por liga)
    teamSeason = 2025,       // temporada del historial de cada equipo
  } = opts;
  const pool = makePool();
  const counter = { calls: 0, callsTeamFixtures: 0, saved: 0, skipped: 0, teamsDone: 0 };
  try {
    const apiGet = makeApi(counter);
    // Descubrir equipos (requiere ~2 llamadas/liga; trivial).
    const teamSet = new Set();
    for (const lid of leagues) {
      const s = await resolveSeason(apiGet, lid, discoverSeason);
      const ids = await teamsFromLeague(apiGet, lid, s, nationalOnly);
      ids.forEach(id => teamSet.add(id));
      console.log(`  liga ${lid} (season ${s}): +${ids.length} equipos${nationalOnly ? ' (national)' : ''}`);
    }
    const teams = [...teamSet];
    console.log(`\nEquipos únicos descubiertos: ${teams.length} · historial en temporada ${teamSeason}`);

    if (!run) {
      const AVG_FIX = nationalOnly ? 12 : 30, FX_EP = withOdds ? 7 : 6, TEAM_EP = 10;
      const total = teams.length * (TEAM_EP + 1) + Math.round(teams.length * AVG_FIX * FX_EP / 1.3);
      console.log(`── ESTIMACIÓN ── ~${total} llamadas · ~${Math.round(total / 400)}-${Math.round(total / 180)} min`);
      console.log(`  (idempotente: lo ya capturado por las tandas de clubes no se repite)\n`);
      return { estimate: true, teams: teams.length, estCalls: total };
    }

    if (!process.env.FOOTBALL_API_KEY) throw new Error('FOOTBALL_API_KEY no está en el env');
    const t0 = Date.now();
    await mapPool(teams, concurrency, async (teamId) => {
      await processTeam(pool, apiGet, counter, { season: teamSeason, withOdds }, teamId);
      if (counter.teamsDone % 20 === 0) console.log(`  ${counter.teamsDone}/${teams.length} · calls=${counter.calls} · guardados=${counter.saved} · skip=${counter.skipped} · ${Math.round((Date.now() - t0) / 60000)}min`);
    });
    console.log(`\n✓ Selecciones/ligas completas: ${counter.teamsDone} equipos · ${counter.calls} llamadas · ${counter.saved} payloads nuevos · ${counter.skipped} ya existían.`);
    return { ok: true, ...counter };
  } finally {
    await pool.end();
  }
}

// ────────────────────────────────────────────────────────────────────────
// Captura CRUDA focalizada por fixture — para el cron nocturno de retrain.
//
// A diferencia de runRawBackfill (equipo×temporada completa, pesada), captura
// SOLO los endpoints que leen reenrich/build-profiles/train para una lista de
// fixtures recién finalizados:
//   fixtures (detalle, REFRESCADO si el almacenado aún no estaba finalizado —
//   el seed guardó el stub NS de los fixtures que en ese momento eran futuros),
//   fixtures/statistics, fixtures/events, fixtures/lineups, injuries(fx:),
//   y fixtures/headtohead de los pares NUEVOS (idempotente).
//
// Idempotente: salta lo ya capturado. captureH2H=false lo desactiva.
// ────────────────────────────────────────────────────────────────────────
async function captureFinalizedFixturesRaw(opts = {}) {
  const {
    pool: extPool = null,
    fixtureIds = [],
    season = 2025,
    captureH2H = true,
    h2hLast = 8,
    concurrency = 5,
  } = opts;
  if (!process.env.FOOTBALL_API_KEY) throw new Error('FOOTBALL_API_KEY no está en el env');
  const pool = extPool || makePool();
  const ownPool = !extPool;
  const counter = { calls: 0, saved: 0, skipped: 0, refreshed: 0, fixturesDone: 0, h2hSaved: 0 };
  try {
    const apiGet = makeApi(counter);
    const pairs = new Set();

    await mapPool(fixtureIds, concurrency, async (fid) => {
      // 1) Detalle del fixture: refrescar si no hay nada o el almacenado aún no
      //    está finalizado (stub NS del seed). ON CONFLICT DO UPDATE sobrescribe.
      const { rows: stRows } = await pool.query(
        `SELECT payload->'fixture'->'status'->>'short' AS st FROM raw_api_payloads WHERE endpoint='fixtures' AND ref_id=$1 AND sub_key=''`,
        [fid]
      );
      let fx = null;
      if (!stRows.length || !FINISHED.has(stRows[0].st)) {
        const resp = await apiGet(`/fixtures?id=${fid}`);
        fx = Array.isArray(resp?.response) ? resp.response[0] : null;
        if (fx) {
          await pool.query(
            `INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
             VALUES ('fixtures','fixture',$1,$2,'',$3::jsonb,NOW())
             ON CONFLICT (endpoint, ref_id, sub_key) DO UPDATE SET payload=EXCLUDED.payload, fetched_at=NOW()`,
            [fid, season, JSON.stringify(fx)]
          );
          counter.refreshed++;
        }
      }
      // Recuperar el payload almacenado si no lo acabamos de traer (para el par H2H).
      if (!fx) {
        const { rows } = await pool.query(
          `SELECT payload FROM raw_api_payloads WHERE endpoint='fixtures' AND ref_id=$1 AND sub_key=''`,
          [fid]
        );
        fx = rows[0]?.payload || null;
      }

      // 2) Endpoints por fixture que consume el retrain + el modelo nuevo (idempotentes).
      //    fixtures/players (FASE 2E): la nocturna NO lo capturaba → los perfiles de
      //    jugador envejecían (solo el 15% tenía players). Ahora cada partido finalizado
      //    entra con datos de jugador. Idempotente: captureOnce salta lo ya guardado.
      const ep = [
        ['fixtures/statistics', `/fixtures/statistics?fixture=${fid}`, ''],
        ['fixtures/events',     `/fixtures/events?fixture=${fid}`,     ''],
        ['fixtures/lineups',    `/fixtures/lineups?fixture=${fid}`,    ''],
        ['fixtures/players',    `/fixtures/players?fixture=${fid}`,    ''],
        ['injuries',            `/injuries?fixture=${fid}`,            `fx:${fid}`],
      ];
      for (const [endpoint, path, subKey] of ep) {
        await captureOnce(pool, apiGet, counter, { endpoint, refType: 'fixture', refId: fid, season, subKey, path });
      }

      const a = fx?.teams?.home?.id, b = fx?.teams?.away?.id;
      if (captureH2H && a && b) pairs.add(`${Math.min(a, b)}-${Math.max(a, b)}`);
      counter.fixturesDone++;
    });

    // 3) H2H de pares NUEVOS (convención: ref_id=LEAST, sub_key=GREATEST — igual
    //    que capture-h2h.js, para que train-meta-models lo encuentre).
    if (captureH2H) {
      for (const key of pairs) {
        const [a, b] = key.split('-').map(Number);
        const { rows } = await pool.query(
          `SELECT 1 FROM raw_api_payloads WHERE endpoint='fixtures/headtohead' AND ref_id=$1 AND sub_key=$2`,
          [a, String(b)]
        );
        if (rows.length) { counter.skipped++; continue; }
        const resp = await apiGet(`/fixtures/headtohead?h2h=${a}-${b}&last=${h2hLast}`);
        await saveValue(pool, { endpoint: 'fixtures/headtohead', refType: 'pair', refId: a, season: null, subKey: String(b), payload: resp });
        counter.h2hSaved++;
      }
    }

    console.log(`[capture-finalized] fixtures=${counter.fixturesDone} · refrescados=${counter.refreshed} · payloads nuevos=${counter.saved} · h2h nuevos=${counter.h2hSaved} · skip=${counter.skipped} · calls=${counter.calls}`);
    return { ok: true, ...counter };
  } finally {
    if (ownPool) await pool.end();
  }
}

module.exports = { runRawBackfill, runRawBackfillLeagues, getTeamsForHalf, SELECCIONES_LEAGUES, captureFinalizedFixturesRaw };
