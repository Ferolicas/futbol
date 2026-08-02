/* eslint-disable */
// lib/model-engine.js — motor empírico contextual de CF Análisis.
//
// Regla contractual del producto:
//   probabilidad = frecuencia de cumplimiento observada en hechos reales,
//   ponderada por actualidad y semejanza con el partido de hoy.
//
// No hay mínimos/máximos de muestra, shrinkage, priors de liga ni intervalos
// que alteren el porcentaje. Un partido disponible sirve; cero partidos para
// una métrica significa "sin dato". Cada fixture se cuenta una sola vez.
//
//   computeBaseMarkets(pool, ctx, { cache? }) -> { fixture, markets }
//   ctx: { homeTeamId, awayTeamId, competitionId, season, phase,
//          homeRank, awayRank, nTeams, cutoff }
//
// Diseño:
//   • Todos los partidos del equipo entran una sola vez.
//   • La temporada actual y el histórico se calculan por separado. Si existen
//     ambos, la actualidad domina mediante currentShare; si solo existe uno,
//     ese bloque vale 100% (un recién ascendido nunca queda vetado).
//   • Localía, tier del rival, fase y H2H son pesos de similitud sobre resultados
//     reales; jamás suman/restan puntos porcentuales por sí mismos.
//   • Los pesos activos se versionan en prediction_models y el entrenamiento
//     nocturno solo puede activar una configuración que mejore fuera de muestra.
//   • rank-tier = tercios (alto/medio/bajo) vía nTeams; rank del rival pasado =
//     rank_before (point-in-time, anti-fuga). phase-tier solo si hoy es knockout.
//   • Líneas generadas sobre el soporte observado (localía). Tarjetas = yellow+red.
//   • 1X2 = combinación empírica ½·(local + simétrico visitante), normalizada.
//
// ANTI-FUGA: TODO se cuenta con `kickoff < cutoff`. Serving: cutoff=now y el caller
// pasa rank oficial. Backtest: cutoff=kickoff del partido y rank_before. Una sola
// función; los perfiles/player_impact NO se leen aquí (esto cuenta de los hechos).

const K = 12;               // solo metadato de cobertura; NO modifica probabilidades
const LINE_PCT = 0.95;      // las líneas cubren hasta el p95 del soporte observado de cada familia
const LINE_HARD_CAP = 50;   // tope duro de seguridad (evita cientos de líneas ante outliers)
const ENGINE_CONFIG_MARKET = '__empirical_engine__';
const ENGINE_CONFIG_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ENGINE_CONFIG = Object.freeze({
  currentShare: 0.72,
  venueBoost: 1.18,
  opponentTierBoost: 1.10,
  phaseBoost: 1.06,
  h2hBoost: 1.22,
  refereeBoost: 1.10,
  // Se mantiene neutro hasta que el entrenamiento point-in-time demuestre que
  // dar más peso a XI históricos parecidos mejora fuera de muestra.
  lineupBoost: 1.00,
});
let engineConfigCache = null;
let engineConfigCacheAt = 0;
// Jugador (4C-2)
const PLAYER_WIN = 10;          // ventana de apariciones para "titular habitual"
const PLAYER_MIN_APP = 1;       // cualquier aparición real es evidencia; sin veto arbitrario
const PLAYER_STARTER_RATIO = 0.6; // is_starter en ≥60% de la ventana
const PLAYER_K = 5;             // suavizado de confianza del delta: c = n_eff/(n_eff+K)
const PLAYER_CAP = 1;           // tope ±1 del shift agregado por canal (red de seguridad final)
const PLAYER_DRAW_BAND = 0.5;   // banda de empate al recontar result desplazado
const PLAYER_ROLE_ROWS = 1320;  // filas recientes de lineups para clasificar posición (~60 fixtures × 22)
const R_DECAY = 0.5;            // rendimientos decrecientes en la agregación amortiguada (ajustable)
const K_DELTA_MERMA = 0.5;      // peso del |delta_canal| en la merma posicional (1X2)
const MERMA_CAP = 8.0;          // tope de la merma agregada (alto: no aplasta la dif. entre 4 y 10 bajas; 4E lo afina)
const MERMA_GOAL_MAX = 1.2;     // gol-equivalente MÁXIMO de la merma al entrar al recuento del 1X2 (saturación suave)
const MERMA_SCALE = 4.0;        // escala de la saturación: gol_equiv = MERMA_GOAL_MAX·(1−e^(−merma/MERMA_SCALE))
const POS_FLOOR = { G: 1.0, 'D-central': 1.0, 'D-lateral': 0.45, M: 0.7, F: 1.0 };

// columnas crudas que necesita el conteo (todas int/bool/char → tipos JS limpios)
const COLS = `tms.fixture_id, tms.kickoff, tms.is_home, tms.team_id, tms.opponent_id,
  tms.competition_id, tms.season,
  tms.total_goals, tms.goals_for, tms.goals_against, tms.btts, tms.clean_sheet,
  tms.corners_for, tms.corners_against, tms.shots_for, tms.shots_against,
  tms.sot_for, tms.sot_against, tms.fouls_for, tms.fouls_against,
  tms.offsides_for, tms.offsides_against,
  tms.yellow_for, tms.yellow_against, tms.red_for, tms.red_against,
  tms.result, tms.phase,
  tms.gf_1h, tms.gf_2h, tms.ga_1h, tms.ga_2h,
  tms.corners_1h, tms.corners_2h, tms.shots_1h, tms.shots_2h,
  tms.sot_1h, tms.sot_2h, tms.fouls_1h, tms.fouls_2h,
  tms.had_red_for, tms.had_red_against, tms.first_goal_minute`;

// ── helpers numéricos / de familia ────────────────────────────────────────
const num = (x) => (x == null ? null : Number(x));
const add2 = (a, b) => (a == null || b == null ? null : Number(a) + Number(b));            // total = for + against
const cardsOne = (y, r) => (y == null ? null : Number(y) + (r == null ? 0 : Number(r)));    // por equipo: yellow+red
const cardsTot = (y1, r1, y2, r2) =>
  (y1 == null || y2 == null ? null : Number(y1) + (r1 ? Number(r1) : 0) + Number(y2) + (r2 ? Number(r2) : 0));

// Seis decimales conservan la frecuencia ponderada internamente. El tope visual
// de 95% se aplica después y nunca vuelve a entrar en el cálculo del motor.
const round = (x) => (x == null ? null : Math.round(x * 1_000_000) / 1_000_000);
const conf = (n) => n > 0 ? n / (n + K) : 0;
const isKnockoutPhase = (p) => p === 'knockout' || p === 'final';

const bounded = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

function normalizeEngineConfig(raw = {}) {
  return {
    // La actualidad siempre debe pesar estrictamente más que el histórico.
    currentShare: bounded(raw.currentShare, DEFAULT_ENGINE_CONFIG.currentShare, 0.55, 0.95),
    venueBoost: bounded(raw.venueBoost, DEFAULT_ENGINE_CONFIG.venueBoost, 1, 2),
    opponentTierBoost: bounded(raw.opponentTierBoost, DEFAULT_ENGINE_CONFIG.opponentTierBoost, 1, 2),
    phaseBoost: bounded(raw.phaseBoost, DEFAULT_ENGINE_CONFIG.phaseBoost, 1, 2),
    h2hBoost: bounded(raw.h2hBoost, DEFAULT_ENGINE_CONFIG.h2hBoost, 1, 2),
    refereeBoost: bounded(raw.refereeBoost, DEFAULT_ENGINE_CONFIG.refereeBoost, 1, 2),
    lineupBoost: bounded(raw.lineupBoost, DEFAULT_ENGINE_CONFIG.lineupBoost, 1, 2.5),
  };
}

async function loadEngineConfig(pool) {
  if (engineConfigCache && Date.now() - engineConfigCacheAt < ENGINE_CONFIG_TTL_MS) return engineConfigCache;
  try {
    const { rows } = await pool.query(
      `SELECT weights, version, metrics
       FROM prediction_models
       WHERE sport='football' AND market_key=$1 AND model_type='empirical-weighting' AND active=TRUE
       ORDER BY version DESC LIMIT 1`,
      [ENGINE_CONFIG_MARKET],
    );
    const row = rows[0];
    engineConfigCache = {
      ...normalizeEngineConfig(row?.weights || {}),
      version: row?.version || 0,
      metrics: row?.metrics || null,
    };
  } catch {
    // La tabla/configuración es optimización operativa, no requisito para calcular.
    engineConfigCache = { ...DEFAULT_ENGINE_CONFIG, version: 0, metrics: null };
  }
  engineConfigCacheAt = Date.now();
  return engineConfigCache;
}

function resetEngineConfigCache() {
  engineConfigCache = null;
  engineConfigCacheAt = 0;
}

function tier(rank, n) {
  if (!rank || !n || n < 6) return null;
  const t = n / 3;
  if (rank <= t) return 'top';
  if (rank <= 2 * t) return 'mid';
  return 'bot';
}

// percentil por rango-más-cercano (vals enteros) para acotar el rango de líneas.
function percentile(vals, q) {
  const a = vals.slice().sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1));
  return a[idx];
}

// Familias contables: total = expresión del partido; team = del equipo (perspectiva).
const OU_FAMILIES = [
  { key: 'goals',    total: (r) => num(r.total_goals),                                  team: (r) => num(r.goals_for),    against: (r) => num(r.goals_against) },
  { key: 'corners',  total: (r) => add2(r.corners_for, r.corners_against),              team: (r) => num(r.corners_for),  against: (r) => num(r.corners_against) },
  { key: 'cards',    total: (r) => cardsTot(r.yellow_for, r.red_for, r.yellow_against, r.red_against), team: (r) => cardsOne(r.yellow_for, r.red_for), against: (r) => cardsOne(r.yellow_against, r.red_against) },
  { key: 'shots',    total: (r) => add2(r.shots_for, r.shots_against),                  team: (r) => num(r.shots_for),    against: (r) => num(r.shots_against) },
  { key: 'sot',      total: (r) => add2(r.sot_for, r.sot_against),                      team: (r) => num(r.sot_for),      against: (r) => num(r.sot_against) },
  { key: 'fouls',    total: (r) => add2(r.fouls_for, r.fouls_against),                  team: (r) => num(r.fouls_for),    against: (r) => num(r.fouls_against) },
  { key: 'offsides', total: (r) => add2(r.offsides_for, r.offsides_against),            team: (r) => num(r.offsides_for), against: (r) => num(r.offsides_against) },
];

// ── primitivas de conteo ──────────────────────────────────────────────────
// fn(row) -> 1 | 0 | null (null = la métrica no existe en esa fila).
function pRate(rows, fn) {
  let s = 0, n = 0;
  for (const r of rows) { const v = fn(r); if (v == null) continue; s += v; n++; }
  return n ? { p: s / n, n, hits: s } : { p: null, n: 0, hits: 0 };
}

function weightedSegmentRate(rows, fn) {
  let weightedHits = 0, weight = 0, hits = 0, n = 0;
  for (const r of rows) {
    const v = fn(r);
    if (v == null) continue;
    const w = Number.isFinite(Number(r._weight)) && Number(r._weight) > 0 ? Number(r._weight) : 1;
    weightedHits += w * Number(v);
    weight += w;
    hits += Number(v);
    n++;
  }
  return n ? { p: weightedHits / weight, n, hits, weightedHits, weight } : { p: null, n: 0, hits: 0, weightedHits: 0, weight: 0 };
}

// Actualidad e histórico son dos bloques independientes. Esto evita que 1.000
// partidos viejos aplasten 2 partidos de la plantilla actual y, a la vez, usa
// todo el historial disponible. Sin histórico, la actualidad conserva 100%;
// sin actualidad, el histórico conserva 100%.
function empiricalRate(rows, fn, currentShare = DEFAULT_ENGINE_CONFIG.currentShare) {
  const current = weightedSegmentRate(rows.filter((r) => r._current === true), fn);
  const historical = weightedSegmentRate(rows.filter((r) => r._current !== true), fn);
  let p = null;
  if (current.n && historical.n) p = currentShare * current.p + (1 - currentShare) * historical.p;
  else if (current.n) p = current.p;
  else if (historical.n) p = historical.p;
  const n = current.n + historical.n;
  return {
    p, n, hits: current.hits + historical.hits,
    weightedHits: current.weightedHits + historical.weightedHits,
    weight: current.weight + historical.weight,
    current, historical,
  };
}

function auditChain(est, currentShare) {
  return [{
    step: 'empirical-weighted',
    p: round(est.p), n: est.n, hits: est.hits,
    currentShare: est.current.n && est.historical.n ? round(currentShare) : (est.current.n ? 1 : 0),
    current: { p: round(est.current.p), n: est.current.n, hits: est.current.hits, weight: round(est.current.weight) },
    historical: { p: round(est.historical.p), n: est.historical.n, hits: est.historical.hits, weight: round(est.historical.weight) },
  }];
}

// ── lectura de hechos (cutoff aplicado) ───────────────────────────────────
function rowMap(r) {
  // opp_rank ya viene calculado del SELECT (rank_before del rival, point-in-time)
  r.kickoff = r.kickoff instanceof Date ? r.kickoff : new Date(r.kickoff);
  return r;
}

async function fetchTeamRows(pool, teamId, cutoff) {
  const { rows } = await pool.query(
    `SELECT ${COLS}, m.referee,
            CASE WHEN tms.is_home THEN m.away_rank_before ELSE m.home_rank_before END AS opp_rank
     FROM model.team_match_stats tms
     JOIN model.matches m ON m.fixture_id = tms.fixture_id
     WHERE tms.team_id = $1 AND tms.kickoff < $2
     ORDER BY tms.kickoff DESC`, [teamId, cutoff]);
  return rows.map(rowMap);
}

function contextualizeRows(rows, contrib, ctx, config) {
  const targetTier = contrib.todayTier;
  const targetReferee = normalizeReferee(ctx.referee);
  return rows.map((r) => {
    let weight = 1;
    if (r.is_home === contrib.venueIsHome) weight *= config.venueBoost;
    if (targetTier && tier(r.opp_rank, ctx.nTeams) === targetTier) weight *= config.opponentTierBoost;
    if (ctx.phase && r.phase === ctx.phase) weight *= config.phaseBoost;
    if (Number(r.opponent_id) === Number(contrib.targetOpponentId)) weight *= config.h2hBoost;
    if (r._lineupSimilarity != null) {
      // Todos los partidos siguen pesando al menos 1. El XI solo da peso extra
      // proporcional a la similitud observada (0..1), nunca inventa un gol ni
      // suma/resta puntos porcentuales.
      weight *= 1 + (config.lineupBoost - 1) * Number(r._lineupSimilarity);
    }
    return {
      ...r,
      _weight: weight,
      _sameReferee: !!targetReferee && normalizeReferee(r.referee) === targetReferee,
      _current: ctx.season != null && Number(r.season) === Number(ctx.season),
    };
  });
}

function normalizeReferee(value) {
  return String(value || '')
    .split(',')[0]
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// El árbitro solo pondera familias sobre las que tiene relación directa
// (tarjetas, faltas y expulsiones). Nunca altera goles/córners/tiros por decreto.
function withRefereeWeight(rows, config) {
  return rows.map((row) => row._sameReferee
    ? { ...row, _weight: Number(row._weight || 1) * config.refereeBoost }
    : row);
}

function unionRows(rowGroups) {
  const byFixture = new Map();
  for (const r of rowGroups.flat()) {
    const prev = byFixture.get(Number(r.fixture_id));
    if (!prev || Number(r._weight || 1) > Number(prev._weight || 1)) byFixture.set(Number(r.fixture_id), r);
  }
  return [...byFixture.values()].sort((a, b) => b.kickoff - a.kickoff);
}

// Proyección de una métrica de un equipo: cruza lo que el propio equipo hace
// con lo que sus rivales de hoy suelen conceder. Si ambos aportan el mismo H2H,
// unionRows lo cuenta una sola vez (el valor observado es el mismo).
function projectMetricRows(primaryRows, primaryFn, opponentRows, opponentAgainstFn) {
  return unionRows([
    primaryRows.map((r) => ({ ...r, _metric: primaryFn(r) })),
    opponentRows.map((r) => ({ ...r, _metric: opponentAgainstFn(r) })),
  ]);
}

// Anota cada antecedente con la fracción del XI confirmado de hoy que también
// fue titular en ese partido histórico. Solo usa model.lineups real; fixtures
// sin alineación registrada quedan null y conservan peso base 1.
async function annotateLineupSimilarity(pool, rawRows, currentLineups, ctx) {
  const flat = lineupRowsFromApi(currentLineups).filter((row) => row.is_starter && row.team_id && row.player_id);
  const byTeam = new Map();
  for (const row of flat) {
    if (!byTeam.has(Number(row.team_id))) byTeam.set(Number(row.team_id), new Set());
    byTeam.get(Number(row.team_id)).add(Number(row.player_id));
  }
  const homeIds = [...(byTeam.get(Number(ctx.homeTeamId)) || [])];
  const awayIds = [...(byTeam.get(Number(ctx.awayTeamId)) || [])];
  if (!pool || (!homeIds.length && !awayIds.length)) {
    return { ...rawRows, context: { homeStarters: homeIds.length, awayStarters: awayIds.length, historicalRows: 0 } };
  }
  const fixtureIds = [...new Set([...(rawRows.homeRaw || []), ...(rawRows.awayRaw || [])]
    .map((row) => Number(row.fixture_id)).filter(Boolean))];
  if (!fixtureIds.length) {
    return { ...rawRows, context: { homeStarters: homeIds.length, awayStarters: awayIds.length, historicalRows: 0 } };
  }
  const { rows } = await pool.query(
    `SELECT lu.fixture_id,lu.team_id,count(*)::int lineup_size,
            count(*) FILTER (WHERE
              (lu.team_id=$2 AND lu.player_id=ANY($3::bigint[])) OR
              (lu.team_id=$4 AND lu.player_id=ANY($5::bigint[]))
            )::int matched
     FROM model.lineups lu
     WHERE lu.fixture_id=ANY($1::bigint[])
       AND lu.team_id=ANY($6::bigint[]) AND lu.is_starter=TRUE
     GROUP BY lu.fixture_id,lu.team_id`,
    [fixtureIds, Number(ctx.homeTeamId), homeIds, Number(ctx.awayTeamId), awayIds,
      [Number(ctx.homeTeamId), Number(ctx.awayTeamId)]],
  );
  const similarity = new Map();
  for (const row of rows) {
    const targetN = Number(row.team_id) === Number(ctx.homeTeamId) ? homeIds.length : awayIds.length;
    if (!targetN || Number(row.lineup_size) <= 0) continue;
    similarity.set(`${row.fixture_id}:${row.team_id}`, Math.max(0, Math.min(1, Number(row.matched || 0) / targetN)));
  }
  const annotate = (items, teamId) => items.map((row) => ({
    ...row,
    _lineupSimilarity: similarity.has(`${row.fixture_id}:${teamId}`)
      ? similarity.get(`${row.fixture_id}:${teamId}`)
      : null,
  }));
  return {
    homeRaw: annotate(rawRows.homeRaw || [], Number(ctx.homeTeamId)),
    awayRaw: annotate(rawRows.awayRaw || [], Number(ctx.awayTeamId)),
    context: {
      homeStarters: homeIds.length,
      awayStarters: awayIds.length,
      historicalRows: similarity.size,
    },
  };
}

// ── constructores de mercado ──────────────────────────────────────────────
function buildOU(rows, valFn, config) {
  const vals = rows.map(valFn).filter((v) => v != null);
  if (!vals.length) return null;
  // rango de líneas = soporte REAL: hasta el p95 observado, no un tope fijo. Así
  // tiros/faltas llegan a ~30/~25 y goles a ~6 (cada familia su rango natural,
  // cubriendo hasta donde el over cae a ~5-10%); tope duro de seguridad.
  const hi = Math.max(0.5, Math.min(percentile(vals, LINE_PCT), LINE_HARD_CAP));
  const lines = [];
  for (let L = 0.5; L <= hi; L += 1) lines.push(L);
  const out = [];
  for (const L of lines) {
    const fn = (r) => { const v = valFn(r); return v == null ? null : (v > L ? 1 : 0); };
    const est = empiricalRate(rows, fn, config.currentShare);
    if (est.p == null) continue;
    out.push({ line: L, prob: round(est.p), level: 'empirical', n: est.n, hits: est.hits, conf: round(conf(est.n)), chain: auditChain(est, config.currentShare) });
  }
  return out.length ? { kind: 'ou', lines: out } : null;
}

function buildBool(rows, valFn, config) {
  const fn = (r) => { const v = valFn(r); return v == null ? null : (v ? 1 : 0); };
  const est = empiricalRate(rows, fn, config.currentShare);
  if (est.p == null) return null;
  return { kind: 'bool', prob: round(est.p), level: 'empirical', n: est.n, hits: est.hits, conf: round(conf(est.n)), chain: auditChain(est, config.currentShare) };
}

function buildSideResult(rows, config) {
  const res = { n: 0 };
  for (const O of ['W', 'D', 'L']) {
    const fn = (r) => (r.result == null ? null : (r.result === O ? 1 : 0));
    const est = empiricalRate(rows, fn, config.currentShare);
    res[O] = est.p; res[O + 'n'] = est.n; res[O + 'hits'] = est.hits;
    res.n = Math.max(res.n, est.n);
  }
  return res;
}

// ── Etapa 2: familias por-tiempo + roja + primer gol + derivadas de distribución ──
// (NÚCLEO-only: NO se modulan por H2H/jugador; pasan tal cual. Mismo pooling/escalera).
const BT_GOALS = [   // goles por mitad: total/home/away (gf_Xh con for+against disponibles)
  { key: 'goals_1h', total: (r) => add2(r.gf_1h, r.ga_1h), team: (r) => num(r.gf_1h), against: (r) => num(r.ga_1h) },
  { key: 'goals_2h', total: (r) => add2(r.gf_2h, r.ga_2h), team: (r) => num(r.gf_2h), against: (r) => num(r.ga_2h) },
];
const BT_TEAMONLY = [ // córners/tiros/sot/faltas por mitad: SOLO del equipo (sin against) → home/away, sin total
  { key: 'corners_1h', team: (r) => num(r.corners_1h) }, { key: 'corners_2h', team: (r) => num(r.corners_2h) },
  { key: 'shots_1h', team: (r) => num(r.shots_1h) },     { key: 'shots_2h', team: (r) => num(r.shots_2h) },
  { key: 'sot_1h', team: (r) => num(r.sot_1h) },         { key: 'sot_2h', team: (r) => num(r.sot_2h) },
  { key: 'fouls_1h', team: (r) => num(r.fouls_1h) },     { key: 'fouls_2h', team: (r) => num(r.fouls_2h) },
];
// distribución empírica de goles de un equipo (filas L2) → marginal P(goles=k), k=0..maxK.
function goalPMF(rows, valFn, maxK, config) {
  const hasValue = rows.some((r) => valFn(r) != null);
  if (!hasValue) return null;
  const pmf = new Array(maxK + 1).fill(0);
  for (let k = 0; k <= maxK; k++) {
    const est = empiricalRate(rows, (r) => {
      const v = valFn(r);
      return v == null ? null : (Math.min(maxK, Math.max(0, Math.round(v))) === k ? 1 : 0);
    }, config.currentShare);
    pmf[k] = est.p || 0;
  }
  const total = pmf.reduce((s, p) => s + p, 0) || 1;
  return pmf.map((p) => p / total);
}
// derivadas: doble oportunidad (del 1x2), par/impar (paridad del total observado), marcador
// exacto y hándicap (de las marginales por equipo con independencia). Muta markets.
function buildDerived(markets, homeRows, awayRows, union, config) {
  const MAXG = 6;
  const x = markets['1x2'];
  if (x) markets.double_chance = { kind: 'multi', '1X': round(x.home + x.draw), '12': round(x.home + x.away), 'X2': round(x.draw + x.away) };
  const parity = empiricalRate(union, (r) => r.total_goals == null ? null : (Number(r.total_goals) % 2 === 0 ? 1 : 0), config.currentShare);
  if (parity.p != null) markets.odd_even = { kind: 'multi', even: round(parity.p), odd: round(1 - parity.p), n: parity.n, hits: parity.hits };
  const hp = goalPMF(homeRows, (r) => num(r._metric), MAXG, config);   // ataque local + concesión visitante
  const ap = goalPMF(awayRows, (r) => num(r._metric), MAXG, config);   // ataque visitante + concesión local
  if (!hp || !ap) return;
  const exact = [], diff = {};
  for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) {
    const p = hp[h] * ap[a]; if (p <= 0) continue;
    exact.push({ score: `${h}-${a}`, prob: round(p) });
    const d = h - a; diff[d] = (diff[d] || 0) + p;
  }
  exact.sort((u, v) => v.prob - u.prob);
  markets.exact_score = { kind: 'list', n: homeRows.length + awayRows.length, lines: exact.filter((e) => e.prob >= 0.02).slice(0, 12) };
  const cum = (pred) => { let s = 0; for (const d in diff) if (pred(Number(d))) s += diff[d]; return round(s); };  // prob de que el LOCAL cubra
  markets.handicap_home_asian = { kind: 'multi', 'm0.5': cum((d) => d >= 1), 'm1.5': cum((d) => d >= 2), 'p0.5': cum((d) => d >= 0), 'p1.5': cum((d) => d >= -1) };
  markets.handicap_home_eu = { kind: 'multi', 'm1': cum((d) => d >= 2), 'p1': cum((d) => d >= 0) };
}

// ── entrada principal ─────────────────────────────────────────────────────
async function computeBaseMarkets(pool, ctx, opts = {}) {
  const cutoff = ctx.cutoff || new Date();
  const nTeams = ctx.nTeams || null;
  const isKO = isKnockoutPhase(ctx.phase);
  const config = normalizeEngineConfig(opts.config || await loadEngineConfig(pool));

  let [homeRaw, awayRaw] = opts.rawRows
    ? [opts.rawRows.homeRaw || [], opts.rawRows.awayRaw || []]
    : await Promise.all([
      fetchTeamRows(pool, ctx.homeTeamId, cutoff),
      fetchTeamRows(pool, ctx.awayTeamId, cutoff),
    ]);
  let lineupContext = opts.rawRows?.lineupContext || null;
  if (Array.isArray(opts.currentLineups) && opts.currentLineups.length) {
    const annotated = await annotateLineupSimilarity(pool, { homeRaw, awayRaw }, opts.currentLineups, ctx);
    homeRaw = annotated.homeRaw;
    awayRaw = annotated.awayRaw;
    lineupContext = annotated.context;
  }

  // Todos los partidos entran. Los parecidos al partido de hoy pesan más, sin
  // crear subconjuntos anidados ni volver a contar el mismo fixture.
  const cctx = { ...ctx, nTeams };
  const homeRows = contextualizeRows(homeRaw, {
    venueIsHome: true, todayTier: tier(ctx.awayRank, nTeams), targetOpponentId: ctx.awayTeamId,
  }, cctx, config);
  const awayRows = contextualizeRows(awayRaw, {
    venueIsHome: false, todayTier: tier(ctx.homeRank, nTeams), targetOpponentId: ctx.homeTeamId,
  }, cctx, config);
  const totalRows = unionRows([homeRows, awayRows]);

  const markets = {};
  let homeGoalEvidence = null, awayGoalEvidence = null;
  for (const fam of OU_FAMILIES) {
    const refereeSensitive = fam.key === 'cards' || fam.key === 'fouls';
    const familyHomeRows = refereeSensitive ? withRefereeWeight(homeRows, config) : homeRows;
    const familyAwayRows = refereeSensitive ? withRefereeWeight(awayRows, config) : awayRows;
    const familyTotalRows = refereeSensitive ? unionRows([familyHomeRows, familyAwayRows]) : totalRows;
    const t = buildOU(familyTotalRows, fam.total, config); if (t) markets[`${fam.key}_total`] = t;
    const homeEvidence = projectMetricRows(familyHomeRows, fam.team, familyAwayRows, fam.against);
    const awayEvidence = projectMetricRows(familyAwayRows, fam.team, familyHomeRows, fam.against);
    const h = buildOU(homeEvidence, (r) => r._metric, config); if (h) markets[`${fam.key}_home`] = h;
    const a = buildOU(awayEvidence, (r) => r._metric, config); if (a) markets[`${fam.key}_away`] = a;
    if (fam.key === 'goals') { homeGoalEvidence = homeEvidence; awayGoalEvidence = awayEvidence; }
  }
  const btts = buildBool(totalRows, (r) => r.btts, config);        if (btts) markets.btts = btts;
  const homeCleanEvidence = projectMetricRows(homeRows, (r) => r.clean_sheet, awayRows, (r) => r.goals_for == null ? null : Number(r.goals_for) === 0);
  const awayCleanEvidence = projectMetricRows(awayRows, (r) => r.clean_sheet, homeRows, (r) => r.goals_for == null ? null : Number(r.goals_for) === 0);
  const csH = buildBool(homeCleanEvidence, (r) => r._metric, config); if (csH) markets.clean_sheet_home = csH;
  const csA = buildBool(awayCleanEvidence, (r) => r._metric, config); if (csA) markets.clean_sheet_away = csA;

  // 1X2: si solo un equipo tiene antecedentes, esa evidencia sigue siendo
  // utilizable. La normalización usa únicamente los lados disponibles.
  const hS = buildSideResult(homeRows, config);
  const aS = buildSideResult(awayRows, config);
  const contributors = (hS.n ? 1 : 0) + (aS.n ? 1 : 0);
  if (contributors) {
    let pH = ((hS.n ? hS.W : 0) + (aS.n ? aS.L : 0)) / contributors;
    let pA = ((hS.n ? hS.L : 0) + (aS.n ? aS.W : 0)) / contributors;
    let pD = ((hS.n ? hS.D : 0) + (aS.n ? aS.D : 0)) / contributors;
    const s = pH + pA + pD || 1;
    markets['1x2'] = {
      kind: 'result', level: 'empirical',
      home: round(pH / s), draw: round(pD / s), away: round(pA / s),
      n: totalRows.length, conf: round(conf(totalRows.length)),
      detail: { home_side: hS, away_side: aS },
    };
  }

  // ── Etapa 2: familias por-tiempo / roja / primer gol / derivadas (núcleo-only) ──
  for (const fam of BT_GOALS) {
    const t = buildOU(totalRows, fam.total, config); if (t) markets[`${fam.key}_total`] = t;
    const hRows = projectMetricRows(homeRows, fam.team, awayRows, fam.against);
    const aRows = projectMetricRows(awayRows, fam.team, homeRows, fam.against);
    const h = buildOU(hRows, (r) => r._metric, config); if (h) markets[`${fam.key}_home`] = h;
    const a = buildOU(aRows, (r) => r._metric, config); if (a) markets[`${fam.key}_away`] = a;
  }
  for (const fam of BT_TEAMONLY) {   // solo home/away (sin total: no hay against por mitad)
    const h = buildOU(homeRows, fam.team, config); if (h) markets[`${fam.key}_home`] = h;
    const a = buildOU(awayRows, fam.team, config); if (a) markets[`${fam.key}_away`] = a;
  }
  const refereeHomeRows = withRefereeWeight(homeRows, config);
  const refereeAwayRows = withRefereeWeight(awayRows, config);
  const redHomeRows = projectMetricRows(refereeHomeRows, (r) => r.had_red_for, refereeAwayRows, (r) => r.had_red_against);
  const redAwayRows = projectMetricRows(refereeAwayRows, (r) => r.had_red_for, refereeHomeRows, (r) => r.had_red_against);
  const rH = buildBool(redHomeRows, (r) => r._metric, config); if (rH) markets.red_card_home = rH;
  const rA = buildBool(redAwayRows, (r) => r._metric, config); if (rA) markets.red_card_away = rA;
  const rAny = buildBool(unionRows([refereeHomeRows, refereeAwayRows]), (r) => {
    if (r.had_red_for == null || r.had_red_against == null) return null;
    return r.had_red_for || r.had_red_against;
  }, config); if (rAny) markets.red_card_any = rAny;
  const fg = buildBool(totalRows, (r) => {
    if (r.first_goal_minute != null) return Number(r.first_goal_minute) <= 45;
    // En un 0-0 terminado sabemos que no hubo primer gol. Si sí hubo goles
    // pero faltan los eventos, la respuesta es desconocida y no puede entrar
    // al denominador como un falso "no".
    if (r.total_goals != null && Number(r.total_goals) === 0) return false;
    return null;
  }, config); if (fg) markets.first_goal_1h = fg;
  buildDerived(markets, homeGoalEvidence || [], awayGoalEvidence || [], totalRows, config);

  const result = {
    fixture: {
      homeTeamId: ctx.homeTeamId, awayTeamId: ctx.awayTeamId,
      competitionId: ctx.competitionId, season: ctx.season,
      phase: ctx.phase, isKnockout: isKO,
      homeRank: ctx.homeRank, awayRank: ctx.awayRank, nTeams,
      homeRows: homeRows.length, awayRows: awayRows.length,
      currentHomeRows: homeRows.filter((r) => r._current).length,
      currentAwayRows: awayRows.filter((r) => r._current).length,
      referee: ctx.referee || null,
      lineupContext,
      engineConfig: { ...config },
      cutoff: cutoff instanceof Date ? cutoff.toISOString() : String(cutoff),
    },
    markets,
  };
  // El entrenador reutiliza exactamente las mismas filas point-in-time para
  // evaluar varias configuraciones sin repetir consultas ni cambiar evidencia.
  if (opts.includeRawRows) result.rawRows = { homeRaw, awayRaw, lineupContext };
  return result;
}

// ── inspección H2H ────────────────────────────────────────────────────────
// Los H2H ya forman parte del conteo único mediante opponent_id+h2hBoost.

// duelos directos H-vs-A (perspectiva del LOCAL de hoy), respetando cutoff.
async function fetchH2HRows(pool, homeTeamId, awayTeamId, cutoff) {
  const { rows } = await pool.query(
    `SELECT ${COLS}, m.referee, tms.competition_id AS comp_id, tms.season AS comp_season
     FROM model.team_match_stats tms
     JOIN model.matches m ON m.fixture_id=tms.fixture_id
     WHERE tms.team_id = $1 AND tms.opponent_id = $2 AND tms.kickoff < $3
     ORDER BY tms.kickoff DESC`, [homeTeamId, awayTeamId, cutoff]);
  return rows.map(rowMap);
}

// voltea un row de H → perspectiva de A (para los mercados _away), reusando valFn.
function flipRow(r) {
  return {
    ...r,
    goals_for: r.goals_against, goals_against: r.goals_for,
    corners_for: r.corners_against, corners_against: r.corners_for,
    shots_for: r.shots_against, shots_against: r.shots_for,
    sot_for: r.sot_against, sot_against: r.sot_for,
    fouls_for: r.fouls_against, fouls_against: r.fouls_for,
    offsides_for: r.offsides_against, offsides_against: r.offsides_for,
    yellow_for: r.yellow_against, yellow_against: r.yellow_for,
    red_for: r.red_against, red_against: r.red_for,
    result: r.result === 'W' ? 'L' : (r.result === 'L' ? 'W' : r.result),
    clean_sheet: r.goals_for == null ? null : (r.goals_for === 0), // A deja valla a 0 ⇔ H marcó 0
    // total_goals y btts son simétricos → sin cambio
  };
}

// Compatibilidad con sondas/backtests antiguos. H2H ya está integrado dentro
// de contextualizeRows mediante opponent_id y h2hBoost, por lo que aplicar una
// segunda capa volvería a contar los mismos partidos. Deliberadamente no-op.
function applyH2H(markets) {
  return markets;
}

// ── LEGACY de diagnóstico, fuera del serving ─────────────────────────────
// Estas funciones se conservan temporalmente para comparar auditorías antiguas,
// pero predict() NO las llama ni las exporta. La capa contrafactual que movía
// goles/momios fue reemplazada por annotateLineupSimilarity(), que solo pondera
// cumplimientos observados y sí entra al entrenamiento point-in-time.
// Se aplica después del conteo contextual. Un titular habitual que hoy NO arranca desplaza
// las expectativas del equipo por CANAL, con AGREGACIÓN AMORTIZADA (rendimientos
// decrecientes ordenando por |delta|) — ya no satura a ±1 con muchos ausentes:
//   · goals_for  (delta_gf de ausentes ofensivos F/M) → goals_home/total
//   · goals_against (delta_ga de defensivos G/D) → goals_away/total, clean_sheet, btts
//   · cards (delta_cards de todos) → cards_total/home/away
//   · 1X2 (merma posicional = piso por rol + K·|delta_canal|, SUMA LINEAL acumulativa) → menos victoria del mermado
// Cada delta ponderado por la confianza de SU n (goles n_with/out, cards n_stats, pen n_pen).
// El ladder se RECUENTA sobre L2 desplazando valores observados (pRate) y se compone en
// MOMIOS sobre la prob pos-H2H. Pura, sin escrituras. NO toca córners/tiros/sot/faltas/offsides.

// momios: logit_final = logit(post) + [logit(p_desplazado) − logit(p_original)].
// = multiplicar los momios por el cociente desplazado/original del recuento. Así una
// prob alta baja poco, una media se mueve más, y nunca llega a 0/1.
const clampP = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logit = (p) => Math.log(clampP(p) / (1 - clampP(p)));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
function oddsCompose(post, pOrig, pShift) {
  if (post == null || pOrig == null || pShift == null) return post;
  const dl = logit(pShift) - logit(pOrig);              // efecto empírico en log-momios
  if (!isFinite(dl) || dl === 0) return post;
  return round(sigmoid(logit(post) + dl));
}

// fila con los goles desplazados (gf/ga fraccionarios); los derivados se recalculan
// en los valFn de recuento (umbral 0.5, banda ±0.5), no aquí.
function shiftRow(r, sgf, sga) {
  const gf = r.goals_for == null ? null : r.goals_for + sgf;
  const ga = r.goals_against == null ? null : r.goals_against + sga;
  return { ...r, goals_for: gf, goals_against: ga, total_goals: (gf == null || ga == null) ? null : gf + ga };
}
// valFn de recuento sobre los GOLES (no los booleanos guardados): en filas
// originales coinciden con lo guardado; en desplazadas reflejan el corrimiento.
const rcOverTotal = (L) => (r) => (r.total_goals == null ? null : (r.total_goals > L ? 1 : 0));
const rcOverFor   = (L) => (r) => (r.goals_for == null ? null : (r.goals_for > L ? 1 : 0));
const rcBtts  = (r) => (r.goals_for == null || r.goals_against == null) ? null : ((r.goals_for > 0.5 && r.goals_against > 0.5) ? 1 : 0);
const rcClean = (r) => (r.goals_against == null) ? null : (r.goals_against > 0.5 ? 0 : 1);
const rcRes   = (O) => (r) => { if (r.goals_for == null || r.goals_against == null) return null; const d = r.goals_for - r.goals_against; const res = d > PLAYER_DRAW_BAND ? 'W' : (d < -PLAYER_DRAW_BAND ? 'L' : 'D'); return res === O ? 1 : 0; };

// (1) POSICIÓN: clasifica (player,team) en G/D-central/D-lateral/M/F por el rol MODAL de
// sus titularidades recientes (model.lineups.position + grid). Para 'D', central vs lateral
// por columna en la línea defensiva (misma fila): mín y máx col = laterales; sin grid → central.
function parseGrid(grid) {
  if (!grid || typeof grid !== 'string') return null;
  const m = grid.split(':'); if (m.length !== 2) return null;
  const row = Number(m[0]), col = Number(m[1]);
  return (isFinite(row) && isFinite(col)) ? { row, col } : null;
}
function classifyRoles(rows) {
  const byFix = new Map();
  for (const r of rows) { if (!byFix.has(r.fixture_id)) byFix.set(r.fixture_id, []); byFix.get(r.fixture_id).push(r); }
  const counts = new Map();
  for (const [, roster] of byFix) {
    const lateral = new Set(), byRow = new Map();              // Ds por fila (línea defensiva)
    for (const r of roster) { if (r.position !== 'D') continue; const g = parseGrid(r.grid); if (!g) continue; if (!byRow.has(g.row)) byRow.set(g.row, []); byRow.get(g.row).push({ pid: r.player_id, col: g.col }); }
    for (const [, line] of byRow) {
      if (line.length < 2) continue;                          // 1 D en la fila → central (conservador)
      const mn = Math.min(...line.map((x) => x.col)), mx = Math.max(...line.map((x) => x.col));
      for (const x of line) if (x.col === mn || x.col === mx) lateral.add(x.pid);
    }
    for (const r of roster) {
      let role = null;
      if (r.position === 'G') role = 'G';
      else if (r.position === 'F') role = 'F';
      else if (r.position === 'M') role = 'M';
      else if (r.position === 'D') role = lateral.has(r.player_id) ? 'D-lateral' : 'D-central';
      if (!role) continue;
      const key = `${r.player_id}:${r.team_id}`, m = counts.get(key) || {};
      m[role] = (m[role] || 0) + 1; counts.set(key, m);
    }
  }
  const roleMap = new Map();
  for (const [key, m] of counts) { let best = null, bn = -1; for (const [role, n] of Object.entries(m)) if (n > bn) { best = role; bn = n; } roleMap.set(key, best); }
  return roleMap;
}

// (2) AGREGACIÓN AMORTIGUADA: ordena por |valor| desc y aplica rendimientos decrecientes
// aporte = Σ v_i · R_DECAY^i. Arregla el bug del tope lineal (muchos ausentes ya no saturan).
function dampedAggregate(values) {
  const s = values.slice().sort((a, b) => Math.abs(b) - Math.abs(a));
  let sum = 0; for (let i = 0; i < s.length; i++) sum += s[i] * Math.pow(R_DECAY, i);
  return sum;
}
const conf2 = (a, b) => { const n = Math.min(Number(a) || 0, Number(b) || 0); return n / (n + PLAYER_K); };
const numOr0 = (x) => (x == null ? 0 : Number(x));
// merma (medida lineal de diezmamiento) → gol-equivalente acotado para el recuento del 1X2.
// Saturación suave: inyectar la merma cruda (p.ej. 8) como goles a restar sacaba el recuento
// fuera de rango y colapsaba la banda de empate. gol_equiv(8)≈1.04, gol_equiv(3.8)≈0.74.
const mermaToGoals = (m) => MERMA_GOAL_MAX * (1 - Math.exp(-m / MERMA_SCALE));

// tarjetas del equipo por fila (yellow+red), con / sin desplazamiento (para el ladder de cards).
function cardsForVal(r) { return (r.yellow_for == null || r.red_for == null) ? null : r.yellow_for + r.red_for; }
function cardsAgVal(r)  { return (r.yellow_against == null || r.red_against == null) ? null : r.yellow_against + r.red_against; }
function shiftCardRow(r, sc) {
  const cf = cardsForVal(r), cfS = cf == null ? null : cf + sc, ca = cardsAgVal(r);
  return { _cards_for: cfS, _cards_total: (cfS == null || ca == null) ? null : cfS + ca };
}
const rcCardsFor   = (L) => (r) => (r._cards_for == null ? null : (r._cards_for > L ? 1 : 0));
const rcCardsTotal = (L) => (r) => (r._cards_total == null ? null : (r._cards_total > L ? 1 : 0));

// lee lineup + player_impact (con cards/pen) + ratio de titularidad + roles + filas de hechos.
function lineupRowsFromApi(lineups) {
  const rows = [];
  for (const team of Array.isArray(lineups) ? lineups : []) {
    const teamId = Number(team?.team?.id) || null;
    for (const item of (team?.startXI || [])) {
      if (item?.player?.id) rows.push({ player_id: Number(item.player.id), team_id: teamId, is_starter: true });
    }
    for (const item of (team?.substitutes || [])) {
      if (item?.player?.id) rows.push({ player_id: Number(item.player.id), team_id: teamId, is_starter: false });
    }
  }
  return rows;
}

async function fetchPlayerContext(pool, fixtureId, ctx, opts = {}) {
  const cutoff = ctx.cutoff || new Date();
  const teams = [Number(ctx.homeTeamId), Number(ctx.awayTeamId)];
  const confirmedLineupRows = Array.isArray(opts.currentLineups)
    ? lineupRowsFromApi(opts.currentLineups)
    : null;
  const [lu, imp, sr, rl, homeRows, awayRows] = await Promise.all([
    confirmedLineupRows
      ? Promise.resolve({ rows: confirmedLineupRows })
      : pool.query(`SELECT player_id, is_starter FROM model.lineups WHERE fixture_id = $1`, [fixtureId]),
    pool.query(`SELECT player_id, team_id, delta_gf, delta_ga, delta_cards, delta_pen,
                       n_with, n_without, n_stats_with, n_stats_without, n_pen_with, n_pen_without
                FROM model.player_impact WHERE team_id = ANY($1::bigint[])`, [teams]),
    // ratio de titularidad desde model.lineups (is_starter fiable distingue XI vs banca).
    pool.query(
      `SELECT player_id, team_id, avg(is_starter::int) AS ratio, count(*) AS napp FROM (
         SELECT lu.player_id, lu.team_id, lu.is_starter,
                row_number() OVER (PARTITION BY lu.player_id, lu.team_id ORDER BY m.kickoff DESC) rn
         FROM model.lineups lu
         JOIN model.matches m ON m.fixture_id = lu.fixture_id
         WHERE lu.team_id = ANY($1::bigint[]) AND m.kickoff < $2
       ) t WHERE rn <= ${PLAYER_WIN} GROUP BY player_id, team_id`, [teams, cutoff]),
    // titularidades recientes (position + grid) para clasificar posición.
    pool.query(
      `SELECT lu.player_id, lu.team_id, lu.fixture_id, lu.position, lu.grid
       FROM model.lineups lu JOIN model.matches m ON m.fixture_id = lu.fixture_id
       WHERE lu.team_id = ANY($1::bigint[]) AND lu.is_starter = true AND m.kickoff < $2
       ORDER BY m.kickoff DESC LIMIT ${PLAYER_ROLE_ROWS}`, [teams, cutoff]),
    fetchTeamRows(pool, ctx.homeTeamId, cutoff),
    fetchTeamRows(pool, ctx.awayTeamId, cutoff),
  ]);
  const starters = new Set(lu.rows.filter((r) => r.is_starter === true).map((r) => Number(r.player_id)));
  const ratio = new Map();
  for (const r of sr.rows) ratio.set(`${r.player_id}:${r.team_id}`, { ratio: Number(r.ratio), napp: Number(r.napp) });
  const roleMap = classifyRoles(rl.rows.map((r) => ({ player_id: Number(r.player_id), team_id: Number(r.team_id), fixture_id: Number(r.fixture_id), position: r.position, grid: r.grid })));
  return { hasLineup: lu.rows.length > 0, starters, impact: imp.rows, ratio, roleMap, homeRows, awayRows };
}

// ausentes con impacto: titular habitual (ratio≥0.6, napp≥5 desde lineups) que hoy NO
// arranca. Cada uno aporta por canal, ponderado por la confianza de SU n correcto.
function teamAbsentees(pctx, teamId) {
  const out = [];
  for (const ir of pctx.impact) {
    if (Number(ir.team_id) !== Number(teamId)) continue;
    const pid = Number(ir.player_id);
    const sr = pctx.ratio.get(`${pid}:${teamId}`);
    if (!sr || sr.napp < PLAYER_MIN_APP || sr.ratio < PLAYER_STARTER_RATIO) continue;   // no titular habitual
    if (pctx.starters.has(pid)) continue;                                               // hoy arranca → presente
    const role = pctx.roleMap.get(`${pid}:${teamId}`) || 'D-central';                   // sin clasificación → central
    const cg = conf2(ir.n_with, ir.n_without), cs = conf2(ir.n_stats_with, ir.n_stats_without);
    const dgf = numOr0(ir.delta_gf), dga = numOr0(ir.delta_ga), dcards = numOr0(ir.delta_cards);
    const deltaCanal = (role === 'F' || role === 'M') ? dgf : dga;
    out.push({
      player_id: pid, role,
      gf: cg * dgf,                       // canal goals_for (ofensivos F/M)
      ga: cg * dga,                       // canal goals_against (defensivos G/D): SOLO delta_ga
                                          // (el penalti que es gol ya está en delta_ga; delta_pen NO se suma — sería doble conteo)
      cards: cs * dcards,                 // canal cards (todos)
      merma: POS_FLOOR[role] + K_DELTA_MERMA * Math.abs(deltaCanal), // canal 1X2 (posicional, positivo)
    });
  }
  return out;
}
// canales de un equipo: gf/ga/cards AMORTIGUADOS (impacto solapado; clamp ±1 red final).
// merma LINEAL (acumulativa: mide cuán diezmado está el equipo; 10 bajas > 4) topada en MERMA_CAP.
function teamChannels(absentees) {
  const off = absentees.filter((a) => a.role === 'F' || a.role === 'M');
  const def = absentees.filter((a) => a.role === 'G' || a.role === 'D-central' || a.role === 'D-lateral');
  const cap = (x) => Math.max(-PLAYER_CAP, Math.min(PLAYER_CAP, x));
  return {
    shift_gf: round(cap(-dampedAggregate(off.map((a) => a.gf)))),           // signo −: se QUITA el aporte
    shift_ga: round(cap(-dampedAggregate(def.map((a) => a.ga)))),
    shift_cards: round(cap(-dampedAggregate(absentees.map((a) => a.cards)))),
    merma: round(Math.min(MERMA_CAP, absentees.reduce((s, a) => s + a.merma, 0))),  // SUMA LINEAL (acumulativa)
    ausentes: absentees.map((a) => a.player_id),
    off: off.map((a) => a.player_id), def: def.map((a) => a.player_id),
  };
}
// resumen de canales (también lo usa la sonda para mostrarlos).
function computePlayerShifts(pctx, ctx) {
  return { hasLineup: pctx.hasLineup, home: teamChannels(teamAbsentees(pctx, ctx.homeTeamId)), away: teamChannels(teamAbsentees(pctx, ctx.awayTeamId)) };
}

// paso auditable por mercado: canal aplicado + shift(s) del canal + ausentes por lado.
function pstep(canal, sides) {
  const pick = (c) => {
    const o = { ausentes: c.ausentes };
    if (canal === 'goals') { o.shift_gf = c.shift_gf; o.shift_ga = c.shift_ga; }
    else if (canal === 'cards') { o.shift_cards = c.shift_cards; }
    else if (canal === '1x2') { o.merma = c.merma; }
    return o;
  };
  const s = { step: 'player', canal };
  if (sides.home && sides.away) { s.home = pick(sides.home); s.away = pick(sides.away); }
  else { s.side = pick(sides.home || sides.away); }
  return s;
}
function modPlayerOU(mk, orig, shifted, mkFn, canal, sides) {
  if (!mk) return;
  for (const ln of mk.lines) {
    const fn = mkFn(ln.line);
    const pO = pRate(orig, fn), pS = pRate(shifted, fn);
    if (pO.n === 0 || pO.p == null || pS.p == null) continue;
    const after = oddsCompose(ln.prob, pO.p, pS.p);
    if (after == null || after === ln.prob) continue;
    const st = pstep(canal, sides); st.n = pO.n; st.before = ln.prob; st.after = after;
    ln.chain.push(st); ln.prob = after;
  }
}
function modPlayerBool(mk, orig, shifted, fn, canal, sides) {
  if (!mk) return;
  const pO = pRate(orig, fn), pS = pRate(shifted, fn);
  if (pO.n === 0 || pO.p == null || pS.p == null) return;
  const after = oddsCompose(mk.prob, pO.p, pS.p);
  if (after == null || after === mk.prob) return;
  const st = pstep(canal, sides); st.n = pO.n; st.before = mk.prob; st.after = after;
  (mk.chain = mk.chain || []).push(st); mk.prob = after;
}
function modPlayer1x2(mk, hOrig, hShift, aOrig, aShift, canal, sides) {
  if (!mk) return;
  const dist = (rows) => ({ W: pRate(rows, rcRes('W')).p, D: pRate(rows, rcRes('D')).p, L: pRate(rows, rcRes('L')).p });
  const n = Math.max(pRate(hOrig, rcRes('W')).n, pRate(aOrig, rcRes('W')).n);
  if (n === 0) return;
  const combine = (h, a) => { // misma ½-combinación que el núcleo (H@casa + A@fuera)
    let home = 0.5 * ((h.W || 0) + (a.L || 0)), draw = 0.5 * ((h.D || 0) + (a.D || 0)), away = 0.5 * ((h.L || 0) + (a.W || 0));
    const s = home + draw + away || 1; return { home: home / s, draw: draw / s, away: away / s };
  };
  const base = combine(dist(hOrig), dist(aOrig));
  const shf  = combine(dist(hShift), dist(aShift));
  const before = { home: mk.home, draw: mk.draw, away: mk.away };
  let home = sigmoid(logit(mk.home) + (logit(shf.home) - logit(base.home)));   // momios por componente
  let draw = sigmoid(logit(mk.draw) + (logit(shf.draw) - logit(base.draw)));
  let away = sigmoid(logit(mk.away) + (logit(shf.away) - logit(base.away)));
  const s = home + draw + away || 1;
  mk.home = round(home / s); mk.draw = round(draw / s); mk.away = round(away / s);
  const st = pstep(canal, sides); st.n = n; st.before = before; st.after = { home: mk.home, draw: mk.draw, away: mk.away };
  (mk.chain = mk.chain || []).push(st);
}

// aplica la capa de jugador (4 canales) a goles, cards y 1X2. Muta in-place y devuelve markets.
function applyPlayer(markets, pctx, ctx) {
  if (!markets || !pctx || !pctx.hasLineup) return markets;   // sin lineup → no-op
  const ps = computePlayerShifts(pctx, ctx);
  const H = ps.home, A = ps.away;
  const z = (c) => c.shift_gf === 0 && c.shift_ga === 0 && c.shift_cards === 0 && c.merma === 0;
  if (z(H) && z(A)) return markets;

  const homeVenue = pctx.homeRows.filter((r) => r.is_home === true);   // H@casa (L2)
  const awayVenue = pctx.awayRows.filter((r) => r.is_home === false);  // A@fuera (L2)
  const both = { home: H, away: A };

  // GOLES — canales goals_for (shift_gf) y goals_against (shift_ga); recuento desplazado
  const homeShift = homeVenue.map((r) => shiftRow(r, H.shift_gf, H.shift_ga));
  const awayShift = awayVenue.map((r) => shiftRow(r, A.shift_gf, A.shift_ga));
  modPlayerOU(markets.goals_total, homeVenue.concat(awayVenue), homeShift.concat(awayShift), rcOverTotal, 'goals', both);
  modPlayerOU(markets.goals_home, homeVenue, homeShift, rcOverFor, 'goals', { home: H });
  modPlayerOU(markets.goals_away, awayVenue, awayShift, rcOverFor, 'goals', { away: A });
  modPlayerBool(markets.btts, homeVenue.concat(awayVenue), homeShift.concat(awayShift), rcBtts, 'goals', both);
  modPlayerBool(markets.clean_sheet_home, homeVenue, homeShift, rcClean, 'goals', { home: H });
  modPlayerBool(markets.clean_sheet_away, awayVenue, awayShift, rcClean, 'goals', { away: A });

  // CARDS — canal cards (shift_cards) sobre el ladder de tarjetas
  const hCO = homeVenue.map((r) => shiftCardRow(r, 0)), hCS = homeVenue.map((r) => shiftCardRow(r, H.shift_cards));
  const aCO = awayVenue.map((r) => shiftCardRow(r, 0)), aCS = awayVenue.map((r) => shiftCardRow(r, A.shift_cards));
  modPlayerOU(markets.cards_total, hCO.concat(aCO), hCS.concat(aCS), rcCardsTotal, 'cards', both);
  modPlayerOU(markets.cards_home, hCO, hCS, rcCardsFor, 'cards', { home: H });
  modPlayerOU(markets.cards_away, aCO, aCS, rcCardsFor, 'cards', { away: A });

  // 1X2 — canal merma posicional: el RESULTADO lo decide el margen, que debe moverse por el
  // DIFERENCIAL de merma. En cada venue se resta el gol_equiv del PROPIO equipo a goals_for y
  // el del RIVAL a goals_against (hoy el rival también está diezmado → el equipo encaja menos).
  // Así el margen recontado = (gf−ga) − (geLocal − geVisita); restar solo goals_for no neteaba
  // las dos mermas y, con ambos equipos diezmados, invertía la dirección (el más diezmado subía).
  const geH = mermaToGoals(H.merma), geA = mermaToGoals(A.merma);
  const h1 = homeVenue.map((r) => shiftRow(r, -geH, -geA));   // H@casa: H marca geH menos; su rival (A) marca geA menos
  const a1 = awayVenue.map((r) => shiftRow(r, -geA, -geH));   // A@fuera: A marca geA menos; su rival (H) marca geH menos
  modPlayer1x2(markets['1x2'], homeVenue, h1, awayVenue, a1, '1x2', both);
  return markets;
}

// ── orquestador de serving ────────────────────────────────────────────────
// H2H forma parte del conteo único (h2hBoost), no es una segunda mezcla. La
// capa de jugador conserva su recuento empírico con/sin titulares cuando hay
// lineup confirmado; sin lineup no inventa cambios.
async function predict(pool, ctx, opts = {}) {
  const h2hOn = opts.h2h != null ? !!opts.h2h : process.env.MODEL_H2H_ENABLED !== 'false';
  const hasConfirmedLineups = Array.isArray(opts.currentLineups) && opts.currentLineups.length > 0;
  const loadedConfig = opts.config || await loadEngineConfig(pool);
  const activeConfig = normalizeEngineConfig(loadedConfig);
  const validationFamilies = opts.validationFamilies
    || loadedConfig?.metrics?.candidate?.families
    || null;
  if (!h2hOn) activeConfig.h2hBoost = 1;
  // Con XI confirmado, computeBaseMarkets pondera únicamente hechos históricos
  // con similitud de alineación. Se retiró la antigua capa que desplazaba goles
  // fraccionarios y componía momios: podía mover un porcentaje sin que ese
  // cumplimiento hubiera ocurrido realmente.
  const res = await computeBaseMarkets(pool, ctx, {
    config: activeConfig,
    currentLineups: hasConfirmedLineups ? opts.currentLineups : null,
  });
  let h2hRows = null;
  // Solo se materializa la lista H2H cuando una sonda la pide. Serving ya la
  // integró por opponent_id y evita esta consulta adicional por partido.
  if (opts.includeH2HRows) h2hRows = await fetchH2HRows(pool, ctx.homeTeamId, ctx.awayTeamId, ctx.cutoff);
  const lineupApplied = hasConfirmedLineups && Number(res.fixture?.lineupContext?.historicalRows || 0) > 0
    && Number(activeConfig.lineupBoost) > 1;
  return {
    fixture: res.fixture,
    markets: res.markets,
    h2hRows,
    pctx: null,
    validationFamilies,
    applied: { h2h: h2hOn, player: lineupApplied, lineup: lineupApplied },
  };
}

module.exports = {
  computeBaseMarkets, fetchH2HRows, applyH2H, predict, tier, K,
  DEFAULT_ENGINE_CONFIG, normalizeEngineConfig, empiricalRate,
  loadEngineConfig, resetEngineConfigCache, lineupRowsFromApi, annotateLineupSimilarity,
};
