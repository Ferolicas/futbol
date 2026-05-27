/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Backfill histórico de features_full (Fase 1 modelo contextual).
//
// Para cada partido en match_predictions sin features_full (temporada
// 2025/2026), reconstruye el estado POINT-IN-TIME (justo antes del saque) y
// guarda el snapshot con el MISMO builder que usa el camino en vivo
// (lib/feature-snapshot.js) → paridad train/score garantizada.
//
// Correctitud temporal (sin leakage):
//   - Posición en tabla: se RECONSTRUYE computando los fixtures FT de la
//     liga-temporada ANTERIORES a la fecha del partido (nunca standings de hoy).
//   - Forma últimos 5: fixtures del equipo en la temporada con fecha < kickoff.
//   - Lesionados: /injuries?fixture=<fid> (reportados para ESE partido).
//   - Causalidad (remates/posesión/xG): de los 5 PREVIOS, no del propio partido.
//   - Cuota implícita: /odds?fixture=<fid> (flag si la API ya la purgó).
//
// Idempotente y resumible: solo procesa filas con features_full IS NULL y
// persiste partido a partido. Se puede cortar y reanudar.
//
// Correr en el VPS (llamadas ilimitadas de Football API):
//   node --env-file=.env scripts/backfill-features.js
//   node --env-file=.env scripts/backfill-features.js --season=2025 --limit=50
// ────────────────────────────────────────────────────────────────────────

try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');
const { buildFeatureSnapshot } = require('../lib/feature-snapshot');

const API_HOST = 'v3.football.api-sports.io';
const API_KEY = process.env.FOOTBALL_API_KEY;
const FINISHED = new Set(['FT', 'AET', 'PEN']);

// CLI args
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const SEASON_MIN = Number(args.season) || 2025;   // 2025/2026 por defecto
const LIMIT = args.limit ? Number(args.limit) : null;
const CONCURRENCY = Number(args.concurrency) || 6;

if (!API_KEY) { console.error('FATAL: FOOTBALL_API_KEY no está en el env'); process.exit(1); }

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

// ─── API con reintentos ───────────────────────────────────────────────────
let apiCalls = 0;
async function apiGet(path, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      apiCalls++;
      const res = await fetch(`https://${API_HOST}${path}`, {
        headers: { 'x-apisports-key': API_KEY },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (!res.ok) return [];
      const json = await res.json();
      if (json.errors && Object.keys(json.errors).length > 0) return [];
      return json.response || [];
    } catch (e) {
      if (i === tries - 1) { console.warn(`  api fail ${path}: ${e.message}`); return []; }
      await sleep(1000 * (i + 1));
    }
  }
  return [];
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Cachés (recortan miles de llamadas a un orden manejable) ───────────────
const leagueFixturesCache = new Map(); // `${league}:${season}` → fixtures[]
const teamFixturesCache = new Map();   // `${team}:${season}`   → fixtures[]
const statsCache = new Map();          // fid                   → statistics[]

async function getLeagueFixtures(league, season) {
  const k = `${league}:${season}`;
  if (leagueFixturesCache.has(k)) return leagueFixturesCache.get(k);
  const fx = await apiGet(`/fixtures?league=${league}&season=${season}`);
  leagueFixturesCache.set(k, fx);
  return fx;
}
async function getTeamFixtures(team, season) {
  const k = `${team}:${season}`;
  if (teamFixturesCache.has(k)) return teamFixturesCache.get(k);
  const fx = await apiGet(`/fixtures?team=${team}&season=${season}`);
  teamFixturesCache.set(k, fx);
  return fx;
}
async function getStats(fid) {
  if (statsCache.has(fid)) return statsCache.get(fid);
  const st = await apiGet(`/fixtures/statistics?fixture=${fid}`);
  statsCache.set(fid, st);
  return st;
}

function seasonOf(kickoff) {
  const d = new Date(kickoff);
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

// ─── Reconstrucción de tabla point-in-time ──────────────────────────────────
// Computa puntos/posición de cada equipo usando SOLO partidos FT de la liga
// con fecha anterior al saque del partido objetivo.
function reconstructTable(leagueFixtures, beforeTs) {
  const t = {};
  const ensure = (id) => (t[id] = t[id] || { teamId: id, played: 0, pts: 0, gf: 0, ga: 0 });
  for (const f of leagueFixtures) {
    const ts = new Date(f.fixture?.date).getTime();
    if (!(ts < beforeTs)) continue;
    if (!FINISHED.has(f.fixture?.status?.short)) continue;
    const hg = f.score?.fulltime?.home ?? f.goals?.home;
    const ag = f.score?.fulltime?.away ?? f.goals?.away;
    if (hg == null || ag == null) continue;
    const h = ensure(f.teams.home.id), a = ensure(f.teams.away.id);
    h.played++; a.played++; h.gf += hg; h.ga += ag; a.gf += ag; a.ga += hg;
    if (hg > ag) h.pts += 3; else if (hg < ag) a.pts += 3; else { h.pts++; a.pts++; }
  }
  const arr = Object.values(t).sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf);
  arr.forEach((e, i) => { e.rank = i + 1; });
  const numTeams = arr.length;
  const leaderPts = arr[0]?.pts ?? 0;
  // Línea de descenso ≈ 3º por la cola (aprox; suficiente como feature).
  const relPts = numTeams >= 3 ? arr[numTeams - 3].pts : (arr[numTeams - 1]?.pts ?? 0);
  const totalMatches = numTeams > 1 ? (numTeams - 1) * 2 : 0; // doble vuelta aprox
  const byId = {};
  for (const e of arr) {
    byId[e.teamId] = {
      rank: e.rank, points: e.pts, played: e.played,
      matchesRemaining: totalMatches > 0 ? Math.max(0, totalMatches - e.played) : null,
      gapToLeader: leaderPts - e.pts,
      gapToRelegation: e.pts - relPts,
    };
  }
  return byId;
}

// ─── Enriquecer un partido a la forma _enriched (ESPEJO EXACTO de
//     enrichLastFiveMatches en lib/api-football.js — debe mantenerse igual). ──
function enrichMatch(m, teamId, stats) {
  const isHome = m.teams?.home?.id === teamId;
  const goalsFor = isHome ? m.goals?.home : m.goals?.away;
  const goalsAgainst = isHome ? m.goals?.away : m.goals?.home;
  let result = 'D';
  if (goalsFor != null && goalsAgainst != null) result = goalsFor > goalsAgainst ? 'W' : goalsFor < goalsAgainst ? 'L' : 'D';

  let corners = null, yellowCards = null, redCards = null, shots = null, sot = null, possession = null, xg = null;
  if (Array.isArray(stats) && stats.length) {
    const hId = m.teams?.home?.id, aId = m.teams?.away?.id;
    const val = (tid, type) => {
      const ts = stats.find(s => s.team?.id === tid);
      const v = (ts?.statistics || []).find(s => s.type === type)?.value;
      return v == null ? 0 : (typeof v === 'number' ? v : (parseFloat(String(v)) || 0));
    };
    const num = (tid, type) => {
      const ts = stats.find(s => s.team?.id === tid);
      const v = (ts?.statistics || []).find(s => s.type === type)?.value;
      if (v == null || v === '') return null;
      const n = typeof v === 'number' ? v : parseFloat(String(v).replace('%', ''));
      return Number.isFinite(n) ? n : null;
    };
    corners = { home: val(hId, 'Corner Kicks'), away: val(aId, 'Corner Kicks') }; corners.total = corners.home + corners.away;
    yellowCards = { home: val(hId, 'Yellow Cards'), away: val(aId, 'Yellow Cards') }; yellowCards.total = yellowCards.home + yellowCards.away;
    redCards = { home: val(hId, 'Red Cards'), away: val(aId, 'Red Cards') }; redCards.total = redCards.home + redCards.away;
    shots = { home: num(hId, 'Total Shots'), away: num(aId, 'Total Shots') };
    sot = { home: num(hId, 'Shots on Goal'), away: num(aId, 'Shots on Goal') };
    possession = { home: num(hId, 'Ball Possession'), away: num(aId, 'Ball Possession') };
    xg = { home: num(hId, 'expected_goals'), away: num(aId, 'expected_goals') };
  }
  return { ...m, _enriched: { isHome, result, goalsFor, goalsAgainst, corners, yellowCards, redCards, shots, sot, possession, xg } };
}

async function buildLast5(teamId, season, beforeTs) {
  const fx = await getTeamFixtures(teamId, season);
  const prior = (fx || [])
    .filter(f => new Date(f.fixture?.date).getTime() < beforeTs && FINISHED.has(f.fixture?.status?.short))
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
    .slice(0, 5);
  const out = [];
  for (const f of prior) out.push(enrichMatch(f, teamId, await getStats(f.fixture.id)));
  return out;
}

// Cuota 1X2 (mejor por resultado) desde /odds.
function extractMatchWinner(oddsResp) {
  const bks = oddsResp?.[0]?.bookmakers || [];
  const best = {};
  for (const bk of bks) {
    const bet = (bk.bets || []).find(b => /match winner|1x2|fulltime result/i.test(b.name || ''));
    for (const v of (bet?.values || [])) {
      const key = ({ Home: 'home', Draw: 'draw', Away: 'away' })[v.value];
      const o = parseFloat(v.odd);
      if (key && isFinite(o) && o > 1 && (!best[key] || o > best[key])) best[key] = o;
    }
  }
  return Object.keys(best).length ? best : null;
}

// ─── mapPool concurrencia ───────────────────────────────────────────────────
async function mapPool(items, limit, fn) {
  const ret = []; let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { ret[idx] = await fn(items[idx], idx); } catch (e) { ret[idx] = { error: e.message }; } }
  });
  await Promise.all(workers);
  return ret;
}

// ─── Procesa un partido ─────────────────────────────────────────────────────
async function processMatch(row, leagueFixtures) {
  const homeId = row.home_team?.id, awayId = row.away_team?.id;
  const beforeTs = new Date(row.kickoff).getTime();
  const season = seasonOf(row.kickoff);
  const fixtureMeta = (leagueFixtures || []).find(f => f.fixture?.id === row.fixture_id);

  const table = reconstructTable(leagueFixtures, beforeTs);
  const [homeLast5, awayLast5, injuriesResp] = await Promise.all([
    buildLast5(homeId, season, beforeTs),
    buildLast5(awayId, season, beforeTs),
    apiGet(`/injuries?fixture=${row.fixture_id}`),
  ]);

  // Odds: preferir las point-in-time guardadas en match_analysis. Solo si no
  // hay, intentar /odds (probablemente purgadas para fixtures viejos).
  let matchWinner = row.stored_odds?.matchWinner || null;
  let oddsSource = matchWinner ? 'stored' : null;
  if (!matchWinner) {
    const oddsResp = await apiGet(`/odds?fixture=${row.fixture_id}`);
    matchWinner = extractMatchWinner(oddsResp);
    if (matchWinner) oddsSource = 'api';
  }

  // analysis reconstruido point-in-time — misma forma que el de analyzeMatch.
  const analysis = {
    homeId, awayId,
    homeTeam: row.home_team?.name, awayTeam: row.away_team?.name,
    kickoff: row.kickoff,
    leagueId: row.league_id, league: row.league_name,
    leagueCountry: fixtureMeta?.league?.country || null,
    leagueRound: fixtureMeta?.league?.round || null,
    homeLastFive: homeLast5, awayLastFive: awayLast5,
    odds: matchWinner ? { matchWinner } : {},
    homePosition: table[homeId]?.rank ?? row.home_position ?? null,
    awayPosition: table[awayId]?.rank ?? row.away_position ?? null,
    filteredInjuries: Array.isArray(injuriesResp) ? injuriesResp : [],
    playerHighlights: null, // no reconstruido en backfill → keyAttackersOut=0, injuryCount sí
    h2h: [],
    standingsContext: { home: table[homeId] || null, away: table[awayId] || null },
    refereeStats: null,
  };

  const features = buildFeatureSnapshot(analysis, {});
  // Marca de procedencia + cobertura para auditar el dataset.
  features._source = 'backfill';
  features._coverage = {
    oddsAvailable: !!matchWinner,
    oddsSource,
    tableReconstructed: !!(table[homeId] || table[awayId]),
    xgHome: features.causality?.home?.xgAvailable || false,
    xgAway: features.causality?.away?.xgAvailable || false,
    last5Home: homeLast5.length, last5Away: awayLast5.length,
  };

  await pgPool.query(
    `UPDATE match_predictions SET features_full = $1::jsonb WHERE fixture_id = $2`,
    [JSON.stringify(features), row.fixture_id],
  );
  return features._coverage;
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  const seasonStart = `${SEASON_MIN}-07-01`;
  console.log(`\nBackfill features_full — temporada ≥ ${SEASON_MIN}/${SEASON_MIN + 1} (kickoff ≥ ${seasonStart})`);

  // JOIN match_analysis para recuperar las ODDS POINT-IN-TIME que el sistema ya
  // guardó al analizar cada partido (ma.odds.matchWinner). La API purga las
  // odds de fixtures viejos (/odds devuelve 0%), pero nuestra copia pre-partido
  // sí existe y es la correcta temporalmente.
  let q = `SELECT mp.fixture_id, mp.league_id, mp.league_name, mp.home_team, mp.away_team,
                  mp.kickoff, mp.date, mp.home_position, mp.away_position,
                  ma.odds AS stored_odds
           FROM match_predictions mp
           LEFT JOIN match_analysis ma ON ma.fixture_id = mp.fixture_id
           WHERE mp.features_full IS NULL AND mp.kickoff >= $1
           ORDER BY mp.league_id, mp.kickoff`;
  const params = [seasonStart];
  if (LIMIT) { q += ` LIMIT $2`; params.push(LIMIT); }
  const { rows } = await pgPool.query(q, params);
  console.log(`Partidos a enriquecer: ${rows.length}`);
  if (rows.length === 0) { await pgPool.end(); return; }

  // Agrupar por liga-temporada para reutilizar la llamada de fixtures de liga.
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.league_id}:${seasonOf(r.kickoff)}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }

  let done = 0, failed = 0;
  const cov = { odds: 0, xg: 0, table: 0 };

  for (const [key, groupRows] of groups) {
    const [league, season] = key.split(':').map(Number);
    const leagueFixtures = await getLeagueFixtures(league, season);
    console.log(`\nLiga ${league} (${season}): ${groupRows.length} partidos · fixtures liga=${leagueFixtures.length}`);

    const results = await mapPool(groupRows, CONCURRENCY, async (row) => {
      const c = await processMatch(row, leagueFixtures);
      return c;
    });

    for (const c of results) {
      if (!c || c.error) { failed++; if (c?.error) console.warn(`  fallo: ${c.error}`); continue; }
      done++;
      if (c.oddsAvailable) cov.odds++;
      if (c.xgHome || c.xgAway) cov.xg++;
      if (c.tableReconstructed) cov.table++;
    }
    console.log(`  ✓ acumulado: ${done} hechos, ${failed} fallos, apiCalls=${apiCalls}`);
  }

  console.log(`\n══ RESUMEN ══`);
  console.log(`Enriquecidos: ${done} / ${rows.length}  (fallos: ${failed})`);
  console.log(`Cobertura → odds: ${pct(cov.odds, done)}  xG: ${pct(cov.xg, done)}  tabla: ${pct(cov.table, done)}`);
  console.log(`Llamadas API totales: ${apiCalls}`);
  await pgPool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

function pct(n, d) { return d > 0 ? `${Math.round((n / d) * 100)}%` : 'n/a'; }
