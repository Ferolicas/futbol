/* eslint-disable */
// ─────────────────────────────────────────────────────────────────────────
// lib/baseball-features.js — feature engineering POINT-IN-TIME compartido
// entre scripts/reenrich-baseball.js (entrenamiento) y el worker
// apps/cfanalisis-worker/src/jobs/baseball/analyze.js (runtime).
//
// PARIDAD train↔runtime: una sola implementación, mismo orden de features
// (BASEBALL_FEATURE_ORDER), mismos guards anti-leakage, mismos thresholds
// de "min muestra para emitir feature" → cero drift entre entrenamiento
// y inferencia.
//
// API:
//   - BASEBALL_FEATURE_ORDER  (array, orden estable de las 10 features)
//   - buildBaseballFeatureIndex(pgPool)         → carga el histórico
//   - computeBaseballFeaturesForGame(game, index) → 10 features puras
//
// El index se construye UNA vez por job (memoria ~5-15 MB) y se reutiliza
// para todos los games del día. Para volúmenes mayores conviene cachear
// el index entre invocaciones.
// ─────────────────────────────────────────────────────────────────────────

// Orden estable. Coincide con scripts/train-baseball-meta-models.js y con
// el shape de features_baseball.
const BASEBALL_FEATURE_ORDER = [
  'home_win_rate_last_10',
  'home_runs_per_game_last_30',
  'home_runs_allowed_last_30',
  'away_win_rate_last_10',
  'away_runs_per_game_last_30',
  'away_runs_allowed_last_30',
  'home_starter_era_last_5',
  'away_starter_era_last_5',
  'is_division_game',
  'home_stadium_park_factor',
];

// Mínimos para emitir feature (debajo → NULL → imputado con means[] al inferir).
const MIN_WINRATE_GAMES  = 5;
const MIN_RUNS30_GAMES   = 3;
const MIN_STARTER_STARTS = 2;

function parseInnings(ip) {
  if (ip == null) return 0;
  const n = Number(ip);
  if (!Number.isFinite(n)) return 0;
  const whole = Math.floor(n);
  const outs = Math.round((n - whole) * 10);
  return whole + outs / 3;
}

// Extrae starter (id + IP + ER per game) de un boxscore.
// team.pitchers[0] es el starter por convención MLB Stats API.
function extractStarterFromBoxTeam(team) {
  if (!team) return null;
  const pids = team.pitchers || [];
  if (pids.length === 0) return null;
  const sid = pids[0];
  const pdata = team.players && team.players[`ID${sid}`];
  if (!pdata) return { id: sid, ip: 0, er: 0 };
  const pit = (pdata.stats && pdata.stats.pitching) || {};
  return {
    id: sid,
    ip: parseInnings(pit.inningsPitched),
    er: Number(pit.earnedRuns) || 0,
  };
}

// Carga el index histórico desde Postgres. Streamea boxscores via cursor
// (cada uno ~180 KB, no caben todos en RAM).
async function buildBaseballFeatureIndex(pgPool) {
  // ── 1) Equipos (division + park_factor)
  const { rows: equipos } = await pgPool.query(
    'SELECT team_id, division, park_factor FROM equipos_mlb'
  );
  const teamMeta = new Map(equipos.map(r => [Number(r.team_id), {
    division: r.division || null,
    park_factor: r.park_factor != null ? Number(r.park_factor) : 1.0,
  }]));

  // ── 2) Schedule Final (game completo de la API: scores + probable pitchers)
  const { rows: scheduleRows } = await pgPool.query(
    `SELECT ref_id, season, payload FROM raw_api_payloads WHERE endpoint='mlb-schedule'`
  );

  // ── 3) Pitcher-season (fallback ERA cuando no hay 2 aperturas previas)
  const { rows: psRows } = await pgPool.query(
    `SELECT ref_id, sub_key, payload FROM raw_api_payloads WHERE endpoint='mlb-pitcher-season'`
  );
  const pitcherSeasonEra = new Map();
  for (const r of psRows) {
    const era = r.payload && r.payload.era;
    if (era != null) pitcherSeasonEra.set(`${r.ref_id}|${r.sub_key}`, Number(era));
  }

  // ── 4) Boxscores → starter info por gamePk (vía cursor; ~810 MB total)
  const starterByGame = new Map();
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DECLARE bb_features_bx_cur NO SCROLL CURSOR FOR
       SELECT ref_id, payload FROM raw_api_payloads
       WHERE endpoint='mlb-boxscore' AND sub_key='boxscore'`
    );
    while (true) {
      const { rows } = await client.query('FETCH 200 FROM bb_features_bx_cur');
      if (rows.length === 0) break;
      for (const r of rows) {
        const box = r.payload;
        starterByGame.set(Number(r.ref_id), {
          home: extractStarterFromBoxTeam(box && box.teams && box.teams.home),
          away: extractStarterFromBoxTeam(box && box.teams && box.teams.away),
        });
      }
    }
    await client.query('CLOSE bb_features_bx_cur');
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  // ── 5) Construir games[] y luego indexar histórico de equipos + pitchers
  const games = [];
  for (const r of scheduleRows) {
    const g = r.payload;
    if (!g || !g.status || g.status.detailedState !== 'Final') continue;
    const gamePk = Number(g.gamePk);
    const dateStr = ((g.gameDate || g.officialDate || '') + '').split('T')[0];
    if (!dateStr) continue;
    const homeId = g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.id;
    const awayId = g.teams && g.teams.away && g.teams.away.team && g.teams.away.team.id;
    if (!homeId || !awayId) continue;
    const hs = g.teams.home.score, as = g.teams.away.score;
    if (hs == null || as == null) continue;
    const season = Number(r.season) || new Date(dateStr + 'T12:00:00Z').getUTCFullYear();
    const bx = starterByGame.get(gamePk);
    games.push({
      gamePk, dateStr, season, homeId, awayId,
      homeScore: Number(hs), awayScore: Number(as),
      homeStarterId: (bx && bx.home && bx.home.id) || (g.teams.home.probablePitcher && g.teams.home.probablePitcher.id) || null,
      awayStarterId: (bx && bx.away && bx.away.id) || (g.teams.away.probablePitcher && g.teams.away.probablePitcher.id) || null,
      homeStarterIp: (bx && bx.home && bx.home.ip) || 0,
      homeStarterEr: (bx && bx.home && bx.home.er) || 0,
      awayStarterIp: (bx && bx.away && bx.away.ip) || 0,
      awayStarterEr: (bx && bx.away && bx.away.er) || 0,
    });
  }
  games.sort((a, b) => a.dateStr.localeCompare(b.dateStr) || a.gamePk - b.gamePk);

  // ── 6) Indexar histórico por equipo y por pitcher (ordenado ASC)
  const teamHistory = new Map();
  const pitcherStarts = new Map();
  for (const g of games) {
    const homeRow = { dateStr: g.dateStr, season: g.season, won: g.homeScore > g.awayScore, runsScored: g.homeScore, runsAllowed: g.awayScore };
    const awayRow = { dateStr: g.dateStr, season: g.season, won: g.awayScore > g.homeScore, runsScored: g.awayScore, runsAllowed: g.homeScore };
    if (!teamHistory.has(g.homeId)) teamHistory.set(g.homeId, []);
    if (!teamHistory.has(g.awayId)) teamHistory.set(g.awayId, []);
    teamHistory.get(g.homeId).push(homeRow);
    teamHistory.get(g.awayId).push(awayRow);
    if (g.homeStarterId && g.homeStarterIp > 0) {
      if (!pitcherStarts.has(g.homeStarterId)) pitcherStarts.set(g.homeStarterId, []);
      pitcherStarts.get(g.homeStarterId).push({ dateStr: g.dateStr, ip: g.homeStarterIp, er: g.homeStarterEr });
    }
    if (g.awayStarterId && g.awayStarterIp > 0) {
      if (!pitcherStarts.has(g.awayStarterId)) pitcherStarts.set(g.awayStarterId, []);
      pitcherStarts.get(g.awayStarterId).push({ dateStr: g.dateStr, ip: g.awayStarterIp, er: g.awayStarterEr });
    }
  }

  return { teamMeta, teamHistory, pitcherStarts, pitcherSeasonEra, games };
}

// ── Cálculo de features (puro, sin DB) ──────────────────────────────────
function lastNBefore(history, beforeDate, season, n) {
  const out = [];
  for (const h of history) {
    if (h.season !== season) continue;
    if (h.dateStr >= beforeDate) break;
    out.push(h);
  }
  return out.slice(-n);
}

function inLastDaysBefore(history, beforeDate, season, days) {
  const beforeTs = new Date(beforeDate + 'T00:00:00Z').getTime();
  const afterTs  = beforeTs - days * 86400000;
  const out = [];
  for (const h of history) {
    if (h.season !== season) continue;
    const t = new Date(h.dateStr + 'T00:00:00Z').getTime();
    if (t >= beforeTs) break;
    if (t >= afterTs) out.push(h);
  }
  return out;
}

function eraFromLastStarts(starts, beforeDate, n) {
  const eligible = [];
  for (const s of starts) {
    if (s.dateStr >= beforeDate) break;
    eligible.push(s);
  }
  const recent = eligible.slice(-n);
  if (recent.length < MIN_STARTER_STARTS) return null;
  const totalIp = recent.reduce((a, s) => a + s.ip, 0);
  const totalEr = recent.reduce((a, s) => a + s.er, 0);
  if (totalIp <= 0) return null;
  return (totalEr * 9) / totalIp;
}

// game = { dateStr, season, homeId, awayId, homeStarterId, awayStarterId }
// index = { teamMeta, teamHistory, pitcherStarts, pitcherSeasonEra }
function computeBaseballFeaturesForGame(game, index) {
  const homeMeta = index.teamMeta.get(game.homeId);
  const awayMeta = index.teamMeta.get(game.awayId);
  const homeHist = index.teamHistory.get(game.homeId) || [];
  const awayHist = index.teamHistory.get(game.awayId) || [];

  // 1, 4 — win rate last 10 (misma temporada, ESTRICTAMENTE anterior)
  const h10 = lastNBefore(homeHist, game.dateStr, game.season, 10);
  const a10 = lastNBefore(awayHist, game.dateStr, game.season, 10);
  const home_win_rate_last_10 = h10.length >= MIN_WINRATE_GAMES
    ? h10.filter(x => x.won).length / h10.length : null;
  const away_win_rate_last_10 = a10.length >= MIN_WINRATE_GAMES
    ? a10.filter(x => x.won).length / a10.length : null;

  // 2, 3, 5, 6 — runs scored/allowed últimos 30 días
  const h30 = inLastDaysBefore(homeHist, game.dateStr, game.season, 30);
  const a30 = inLastDaysBefore(awayHist, game.dateStr, game.season, 30);
  const avg = (arr, k) => arr.reduce((a, x) => a + x[k], 0) / arr.length;
  const home_runs_per_game_last_30 = h30.length >= MIN_RUNS30_GAMES ? avg(h30, 'runsScored')  : null;
  const home_runs_allowed_last_30  = h30.length >= MIN_RUNS30_GAMES ? avg(h30, 'runsAllowed') : null;
  const away_runs_per_game_last_30 = a30.length >= MIN_RUNS30_GAMES ? avg(a30, 'runsScored')  : null;
  const away_runs_allowed_last_30  = a30.length >= MIN_RUNS30_GAMES ? avg(a30, 'runsAllowed') : null;

  // 7, 8 — starter ERA last 5 (fallback ERA season-1 si <2 aperturas previas)
  const eraFallback = (pid, season) => {
    if (!pid) return null;
    const v = index.pitcherSeasonEra.get(`${pid}|${season - 1}`);
    return v == null ? null : Number(v);
  };
  let home_starter_era_last_5 = null;
  if (game.homeStarterId) {
    const fromStarts = eraFromLastStarts(index.pitcherStarts.get(game.homeStarterId) || [], game.dateStr, 5);
    home_starter_era_last_5 = fromStarts != null ? fromStarts : eraFallback(game.homeStarterId, game.season);
  }
  let away_starter_era_last_5 = null;
  if (game.awayStarterId) {
    const fromStarts = eraFromLastStarts(index.pitcherStarts.get(game.awayStarterId) || [], game.dateStr, 5);
    away_starter_era_last_5 = fromStarts != null ? fromStarts : eraFallback(game.awayStarterId, game.season);
  }

  // 9 — división
  const is_division_game = !!(homeMeta && awayMeta && homeMeta.division && awayMeta.division && homeMeta.division === awayMeta.division);

  // 10 — park factor del estadio home
  const home_stadium_park_factor = homeMeta && homeMeta.park_factor != null ? Number(homeMeta.park_factor) : 1.0;

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

module.exports = {
  BASEBALL_FEATURE_ORDER,
  buildBaseballFeatureIndex,
  computeBaseballFeaturesForGame,
  // Constantes expuestas por si train/reenrich quieren ajustarlas en futuro.
  MIN_WINRATE_GAMES,
  MIN_RUNS30_GAMES,
  MIN_STARTER_STARTS,
};
