/* eslint-disable */
// lib/model-engine.js — NÚCLEO de conteo del motor multifactor (FASE 4B).
// Probabilidad = FRECUENCIA EMPÍRICA por línea, contada de los HECHOS
// (model.team_match_stats), nunca un promedio colapsado. CommonJS.
//
//   computeBaseMarkets(pool, ctx, { cache? }) -> { fixture, markets }
//   ctx: { homeTeamId, awayTeamId, competitionId, season, phase,
//          homeRank, awayRank, nTeams, cutoff }
//
// Diseño (decisiones del dueño, FASE 4B):
//   • 70/30 por nivel: freqNivel = 0.7·freq(últimas 10 del nivel) + 0.3·freq(todas).
//   • Escalera de contexto (específico→amplio), prioridad localía > rank-tier > phase:
//       L0 localía+rank-tier+phase | L1 localía+rank-tier | L2 localía | L3 todo.
//     (solo se arman los niveles aplicables al fixture de hoy.)
//   • Pooling empírico-bayesiano entre niveles (k=12), anclado en el base-rate de
//     LIGA (cutoff); si la liga es pobre (<50) → base-rate GLOBAL. NO es isotónica.
//   • rank-tier = tercios (alto/medio/bajo) vía nTeams; rank del rival pasado =
//     rank_before (point-in-time, anti-fuga). phase-tier solo si hoy es knockout.
//   • Líneas generadas sobre el soporte observado (localía). Tarjetas = yellow+red.
//   • 1X2 = combinación empírica ½·(local + simétrico visitante), normalizada.
//
// ANTI-FUGA: TODO se cuenta con `kickoff < cutoff`. Serving: cutoff=now y el caller
// pasa rank oficial. Backtest: cutoff=kickoff del partido y rank_before. Una sola
// función; los perfiles/player_impact NO se leen aquí (esto cuenta de los hechos).

const K = 12;               // fuerza del pooling y de la confianza
const BASE_FLOOR = 50;      // muestra mínima del base-rate de liga antes de caer a global
const BASE_CAP_LEAGUE = 4000;
const BASE_CAP_GLOBAL = 6000;
const LINE_PCT = 0.95;      // las líneas cubren hasta el p95 del soporte observado de cada familia
const LINE_HARD_CAP = 50;   // tope duro de seguridad (evita cientos de líneas ante outliers)
const LAST_N = 10;
// H2H (4C-1)
const H2H_A_WEIGHT = 0.6;   // modo (a) temporada actual: peso plano del H2H (sin /2)
const H2H_B_WMAX = 0.30;    // modo (b) histórico: techo del tirón
const H2H_B_K = 5;          // modo (b) suavizado por muestra
// Jugador (4C-2)
const PLAYER_WIN = 10;          // ventana de apariciones para "titular habitual"
const PLAYER_MIN_APP = 5;       // mínimo de apariciones en la ventana para evaluar
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
const COLS = `tms.fixture_id, tms.kickoff, tms.is_home,
  tms.total_goals, tms.goals_for, tms.goals_against, tms.btts, tms.clean_sheet,
  tms.corners_for, tms.corners_against, tms.shots_for, tms.shots_against,
  tms.sot_for, tms.sot_against, tms.fouls_for, tms.fouls_against,
  tms.offsides_for, tms.offsides_against,
  tms.yellow_for, tms.yellow_against, tms.red_for, tms.red_against,
  tms.result, tms.phase`;

// ── helpers numéricos / de familia ────────────────────────────────────────
const num = (x) => (x == null ? null : Number(x));
const add2 = (a, b) => (a == null || b == null ? null : Number(a) + Number(b));            // total = for + against
const cardsOne = (y, r) => (y == null ? null : Number(y) + (r == null ? 0 : Number(r)));    // por equipo: yellow+red
const cardsTot = (y1, r1, y2, r2) =>
  (y1 == null || y2 == null ? null : Number(y1) + (r1 ? Number(r1) : 0) + Number(y2) + (r2 ? Number(r2) : 0));

const round = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const conf = (n) => n / (n + K);
const isKnockoutPhase = (p) => p === 'knockout' || p === 'final';

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
  { key: 'goals',    total: (r) => num(r.total_goals),                                  team: (r) => num(r.goals_for) },
  { key: 'corners',  total: (r) => add2(r.corners_for, r.corners_against),              team: (r) => num(r.corners_for) },
  { key: 'cards',    total: (r) => cardsTot(r.yellow_for, r.red_for, r.yellow_against, r.red_against), team: (r) => cardsOne(r.yellow_for, r.red_for) },
  { key: 'shots',    total: (r) => add2(r.shots_for, r.shots_against),                  team: (r) => num(r.shots_for) },
  { key: 'sot',      total: (r) => add2(r.sot_for, r.sot_against),                      team: (r) => num(r.sot_for) },
  { key: 'fouls',    total: (r) => add2(r.fouls_for, r.fouls_against),                  team: (r) => num(r.fouls_for) },
  { key: 'offsides', total: (r) => add2(r.offsides_for, r.offsides_against),            team: (r) => num(r.offsides_for) },
];

// ── primitiva de conteo ───────────────────────────────────────────────────
// fn(row) -> 1 | 0 | null  (null = la métrica no está en esa fila → se excluye)
function pRate(rows, fn) {
  let s = 0, n = 0;
  for (const r of rows) { const v = fn(r); if (v == null) continue; s += v; n++; }
  return n ? { p: s / n, n } : { p: null, n: 0 };
}

// 70/30 dentro de un nivel (rows YA ordenadas por kickoff desc).
function levelBlend(rows, fn) {
  const all = pRate(rows, fn);
  if (all.n === 0) return { p: null, n: 0 };
  const last = pRate(rows.slice(0, LAST_N), fn);
  const p = last.p == null ? all.p : 0.7 * last.p + 0.3 * all.p;
  return { p, n: all.n };
}

// Pooling EB: ancla (base-rate) → niveles de amplio a específico. Devuelve el
// estimador del nivel más específico disponible, ya encogido, + la cadena auditable.
function poolChain(levelsBroadToSpec, baseP, baseN) {
  let parent = baseP;
  let deepest = { p: baseP, n: 0, level: 'base' };
  const chain = [{ level: 'base', p: round(baseP), n: baseN }];
  for (const lv of levelsBroadToSpec) {
    if (lv.est && lv.est.n > 0 && lv.est.p != null) {
      const pooled = (lv.est.n * lv.est.p + K * parent) / (lv.est.n + K);
      parent = pooled;
      deepest = { p: pooled, n: lv.est.n, level: lv.name };
      chain.push({ level: lv.name, p: round(pooled), n: lv.est.n, raw: round(lv.est.p) });
    }
  }
  return { deepest, chain };
}

// ── lectura de hechos (cutoff aplicado) ───────────────────────────────────
function rowMap(r) {
  // opp_rank ya viene calculado del SELECT (rank_before del rival, point-in-time)
  r.kickoff = r.kickoff instanceof Date ? r.kickoff : new Date(r.kickoff);
  return r;
}

async function fetchTeamRows(pool, teamId, cutoff) {
  const { rows } = await pool.query(
    `SELECT ${COLS},
            CASE WHEN tms.is_home THEN m.away_rank_before ELSE m.home_rank_before END AS opp_rank
     FROM model.team_match_stats tms
     JOIN model.matches m ON m.fixture_id = tms.fixture_id
     WHERE tms.team_id = $1 AND tms.kickoff < $2
     ORDER BY tms.kickoff DESC`, [teamId, cutoff]);
  return rows.map(rowMap);
}

async function getLeagueRows(pool, competitionId, cutoff, cache) {
  const key = `league:${competitionId}`;
  if (cache.has(key)) return cache.get(key);
  const { rows } = await pool.query(
    `SELECT ${COLS}
     FROM model.team_match_stats tms
     JOIN model.matches m ON m.fixture_id = tms.fixture_id
     WHERE m.competition_id = $1 AND tms.kickoff < $2
     ORDER BY tms.kickoff DESC LIMIT ${BASE_CAP_LEAGUE}`, [competitionId, cutoff]);
  const mapped = rows.map(rowMap);
  cache.set(key, mapped);
  return mapped;
}

async function getGlobalRows(pool, cutoff, cache) {
  const key = 'global';
  if (cache.has(key)) return cache.get(key);
  const { rows } = await pool.query(
    `SELECT ${COLS}
     FROM model.team_match_stats tms
     WHERE tms.kickoff < $1
     ORDER BY tms.kickoff DESC LIMIT ${BASE_CAP_GLOBAL}`, [cutoff]);
  const mapped = rows.map(rowMap);
  cache.set(key, mapped);
  return mapped;
}

// base-rate por scope (all|home|away), prefiere liga; si liga<floor → global.
function makeBaseProvider(leagueRows, globalRows) {
  const split = (rows) => ({ all: rows, home: rows.filter((r) => r.is_home), away: rows.filter((r) => !r.is_home) });
  const lg = split(leagueRows);
  const gl = split(globalRows);
  return function base(scope, fn) {
    const L = pRate(lg[scope] || lg.all, fn);
    if (L.n >= BASE_FLOOR && L.p != null) return L;
    const G = pRate(gl[scope] || gl.all, fn);
    if (G.p != null && G.n >= L.n) return G;
    return L.p != null ? L : G;
  };
}

// ── niveles de la escalera ────────────────────────────────────────────────
// contrib: { teamRows (desc), venueIsHome, todayTier }
function levelsFor(contrib, isKO, nTeams) {
  const venue = contrib.teamRows.filter((r) => r.is_home === contrib.venueIsHome);
  const out = [];
  if (isKO && contrib.todayTier) out.push({ name: 'L0', rows: venue.filter((r) => isKnockoutPhase(r.phase) && tier(r.opp_rank, nTeams) === contrib.todayTier) });
  if (contrib.todayTier)         out.push({ name: 'L1', rows: venue.filter((r) => tier(r.opp_rank, nTeams) === contrib.todayTier) });
  out.push({ name: 'L2', rows: venue });
  out.push({ name: 'L3', rows: contrib.teamRows });
  return out; // específico → amplio
}

// une niveles de varios contribuyentes por nombre, dedup por fixture (evita
// doble-conteo si las dos selecciones incluyen un H-vs-A pasado en este venue).
function unionLevels(levelArrays) {
  const order = ['L0', 'L1', 'L2', 'L3'];
  const out = [];
  for (const name of order) {
    let rows = [], any = false;
    for (const levels of levelArrays) { const f = levels.find((l) => l.name === name); if (f) { rows = rows.concat(f.rows); any = true; } }
    if (!any) continue;
    const seen = new Set(); const dedup = [];
    for (const r of rows) { if (seen.has(r.fixture_id)) continue; seen.add(r.fixture_id); dedup.push(r); }
    dedup.sort((a, b) => b.kickoff - a.kickoff);
    out.push({ name, rows: dedup });
  }
  return out;
}

// ── constructores de mercado ──────────────────────────────────────────────
function buildOU(levelsSpecToBroad, valFn, baseScope, base) {
  const l2 = levelsSpecToBroad.find((l) => l.name === 'L2');
  const vals = (l2 ? l2.rows : []).map(valFn).filter((v) => v != null);
  if (!vals.length) return null;
  // rango de líneas = soporte REAL: hasta el p95 observado, no un tope fijo. Así
  // tiros/faltas llegan a ~30/~25 y goles a ~6 (cada familia su rango natural,
  // cubriendo hasta donde el over cae a ~5-10%); tope duro de seguridad.
  const hi = Math.min(percentile(vals, LINE_PCT), LINE_HARD_CAP);
  const lines = [];
  for (let L = 0.5; L < hi; L += 1) lines.push(L);
  if (!lines.length) return null;
  const broadToSpec = levelsSpecToBroad.slice().reverse();
  const out = [];
  for (const L of lines) {
    const fn = (r) => { const v = valFn(r); return v == null ? null : (v > L ? 1 : 0); };
    const levelsEst = broadToSpec.map((lv) => ({ name: lv.name, est: levelBlend(lv.rows, fn) }));
    const b = base(baseScope, fn);
    const { deepest, chain } = poolChain(levelsEst, b.p, b.n);
    if (deepest.p == null) continue;
    out.push({ line: L, prob: round(deepest.p), level: deepest.level, n: deepest.n, conf: round(conf(deepest.n)), chain });
  }
  return out.length ? { kind: 'ou', lines: out } : null;
}

function buildBool(levelsSpecToBroad, valFn, baseScope, base) {
  const broadToSpec = levelsSpecToBroad.slice().reverse();
  const fn = (r) => { const v = valFn(r); return v == null ? null : (v ? 1 : 0); };
  const levelsEst = broadToSpec.map((lv) => ({ name: lv.name, est: levelBlend(lv.rows, fn) }));
  const b = base(baseScope, fn);
  const { deepest, chain } = poolChain(levelsEst, b.p, b.n);
  if (deepest.p == null) return null;
  return { kind: 'bool', prob: round(deepest.p), level: deepest.level, n: deepest.n, conf: round(conf(deepest.n)), chain };
}

function buildSideResult(levelsSpecToBroad, baseScope, base) {
  const broadToSpec = levelsSpecToBroad.slice().reverse();
  const res = {};
  for (const O of ['W', 'D', 'L']) {
    const fn = (r) => (r.result == null ? null : (r.result === O ? 1 : 0));
    const levelsEst = broadToSpec.map((lv) => ({ name: lv.name, est: levelBlend(lv.rows, fn) }));
    const b = base(baseScope, fn);
    const { deepest } = poolChain(levelsEst, b.p, b.n);
    res[O] = deepest.p; res[O + 'n'] = deepest.n;
  }
  return res;
}

// ── entrada principal ─────────────────────────────────────────────────────
async function computeBaseMarkets(pool, ctx, opts = {}) {
  const cutoff = ctx.cutoff || new Date();
  const cache = opts.cache || new Map();
  const nTeams = ctx.nTeams || null;
  const isKO = isKnockoutPhase(ctx.phase);

  const [homeRows, awayRows, leagueRows] = await Promise.all([
    fetchTeamRows(pool, ctx.homeTeamId, cutoff),
    fetchTeamRows(pool, ctx.awayTeamId, cutoff),
    getLeagueRows(pool, ctx.competitionId, cutoff, cache),
  ]);
  const globalRows = await getGlobalRows(pool, cutoff, cache);
  const base = makeBaseProvider(leagueRows, globalRows);

  // contribuyentes: H mira su localía y enfrenta al tier de A; A al de H.
  const homeContrib = { teamRows: homeRows, venueIsHome: true,  todayTier: tier(ctx.awayRank, nTeams) };
  const awayContrib = { teamRows: awayRows, venueIsHome: false, todayTier: tier(ctx.homeRank, nTeams) };
  const homeLevels = levelsFor(homeContrib, isKO, nTeams);   // H@casa
  const awayLevels = levelsFor(awayContrib, isKO, nTeams);   // A@fuera
  const totalLevels = unionLevels([homeLevels, awayLevels]); // H@casa ∪ A@fuera

  const markets = {};
  for (const fam of OU_FAMILIES) {
    const t = buildOU(totalLevels, fam.total, 'all', base);  if (t) markets[`${fam.key}_total`] = t;
    const h = buildOU(homeLevels, fam.team, 'home', base);   if (h) markets[`${fam.key}_home`] = h;
    const a = buildOU(awayLevels, fam.team, 'away', base);   if (a) markets[`${fam.key}_away`] = a;
  }
  const btts = buildBool(totalLevels, (r) => r.btts, 'all', base);          if (btts) markets.btts = btts;
  const csH  = buildBool(homeLevels, (r) => r.clean_sheet, 'home', base);   if (csH) markets.clean_sheet_home = csH;
  const csA  = buildBool(awayLevels, (r) => r.clean_sheet, 'away', base);   if (csA) markets.clean_sheet_away = csA;

  // 1X2: combinar resultado de H@casa y A@fuera, normalizar.
  const hS = buildSideResult(homeLevels, 'home', base);
  const aS = buildSideResult(awayLevels, 'away', base);
  let pH = 0.5 * ((hS.W || 0) + (aS.L || 0));
  let pA = 0.5 * ((hS.L || 0) + (aS.W || 0));
  let pD = 0.5 * ((hS.D || 0) + (aS.D || 0));
  const s = pH + pA + pD || 1;
  markets['1x2'] = {
    kind: 'result',
    home: round(pH / s), draw: round(pD / s), away: round(pA / s),
    n: Math.min(hS.Wn || 0, aS.Wn || 0),
    conf: round(conf(Math.min(hS.Wn || 0, aS.Wn || 0))),
    detail: { home_side: hS, away_side: aS },
  };

  return {
    fixture: {
      homeTeamId: ctx.homeTeamId, awayTeamId: ctx.awayTeamId,
      competitionId: ctx.competitionId, season: ctx.season,
      phase: ctx.phase, isKnockout: isKO,
      homeRank: ctx.homeRank, awayRank: ctx.awayRank, nTeams,
      homeRows: homeRows.length, awayRows: awayRows.length, leagueRows: leagueRows.length,
      cutoff: cutoff instanceof Date ? cutoff.toISOString() : String(cutoff),
    },
    markets,
  };
}

// ── capa H2H (4C-1) ───────────────────────────────────────────────────────
// Se aplica DESPUÉS de computeBaseMarkets sobre la prob por línea ya calculada.
// Modo (a) temporada actual: blend plano 0.6·H2H + 0.4·base (sin /2). Modo (b)
// histórico: tirón suave w=W_MAX·n/(n+k) topado en W_MAX. Stack a→b. Cada paso
// queda en la chain. Pura, sin escrituras; reusa pRate + los valFn del núcleo.

// duelos directos H-vs-A (perspectiva del LOCAL de hoy), respetando cutoff.
async function fetchH2HRows(pool, homeTeamId, awayTeamId, cutoff) {
  const { rows } = await pool.query(
    `SELECT ${COLS}, tms.competition_id AS comp_id, tms.season AS comp_season
     FROM model.team_match_stats tms
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

function h2hCombine(before, h2hP, n, mode) {
  if (mode === 'a') return H2H_A_WEIGHT * h2hP + (1 - H2H_A_WEIGHT) * before;
  const w = H2H_B_WMAX * n / (n + H2H_B_K);
  return (1 - w) * before + w * h2hP;
}

function modOU(mk, rows, valFn, mode) {
  if (!mk) return;
  for (const ln of mk.lines) {
    const fn = (r) => { const v = valFn(r); return v == null ? null : (v > ln.line ? 1 : 0); };
    const h = pRate(rows, fn);
    if (h.n === 0) continue;                       // sin dato H2H para esa familia/línea → no modula
    const before = ln.prob;
    const after = round(h2hCombine(before, h.p, h.n, mode));
    ln.chain.push({ step: 'h2h', mode, before, after, n: h.n });
    ln.prob = after;
  }
}

function modBool(mk, rows, valFn, mode) {
  if (!mk) return;
  const fn = (r) => { const v = valFn(r); return v == null ? null : (v ? 1 : 0); };
  const h = pRate(rows, fn);
  if (h.n === 0) return;
  const before = mk.prob;
  const after = round(h2hCombine(before, h.p, h.n, mode));
  (mk.chain = mk.chain || []).push({ step: 'h2h', mode, before, after, n: h.n });
  mk.prob = after;
}

// blend del 1X2 con peso w explícito (el caller decide w según H2H_1X2_MODE).
// rows YA filtradas por venue. w=null ⇒ curva del modo (b): W_MAX·n/(n+k).
function blend1x2(mk, rows, fixedW, modeLabel) {
  if (!mk) return;
  const W = pRate(rows, (r) => (r.result == null ? null : (r.result === 'W' ? 1 : 0)));
  const D = pRate(rows, (r) => (r.result == null ? null : (r.result === 'D' ? 1 : 0)));
  const L = pRate(rows, (r) => (r.result == null ? null : (r.result === 'L' ? 1 : 0)));
  const n = W.n;
  if (n === 0) return;
  const w = fixedW != null ? fixedW : (H2H_B_WMAX * n / (n + H2H_B_K));
  const before = { home: mk.home, draw: mk.draw, away: mk.away };
  let home = (1 - w) * mk.home + w * W.p;   // H gana = local hoy
  let draw = (1 - w) * mk.draw + w * D.p;
  let away = (1 - w) * mk.away + w * L.p;   // H pierde = visita hoy
  const s = home + draw + away || 1;
  mk.home = round(home / s); mk.draw = round(draw / s); mk.away = round(away / s);
  (mk.chain = mk.chain || []).push({ step: 'h2h', mode: modeLabel, before, after: { home: mk.home, draw: mk.draw, away: mk.away }, n, w: round(w) });
}

// Aplica H2H al 1X2 según H2H_1X2_MODE (env TEMPORAL para comparar en backtest 4E).
// SIN env var → softweight (default del motor; el plano colapsaba con muestra chica,
// p.ej. 1 solo duelo en casa). Venue: solo duelos con el local de hoy en casa.
//   softweight = (DEFAULT) separa a/b, peso de (a)=0.6·n_cur/(n_cur+3) (suave si n_cur chico).
//   merge      = fusiona venue de (a)+(b) en UN conteo y un solo blend (peso 0.6).
//   default    = comportamiento viejo: modo (a) plano 0.6 → modo (b) curva (conservado para 4E).
function apply1x2H2H(mk, cur, hist) {
  if (!mk) return;
  const mode = process.env.H2H_1X2_MODE || 'softweight';  // sin env var → softweight
  const curHV = cur.filter((r) => r.is_home === true);
  const histHV = hist.filter((r) => r.is_home === true);
  if (mode === 'merge') {
    blend1x2(mk, curHV.concat(histHV), H2H_A_WEIGHT, 'merge');
  } else if (mode === 'default') {
    if (curHV.length) blend1x2(mk, curHV, H2H_A_WEIGHT, 'a');           // plano 0.6 (viejo)
    if (histHV.length) blend1x2(mk, histHV, null, 'b');
  } else {                                                              // softweight (default del motor)
    if (curHV.length) blend1x2(mk, curHV, H2H_A_WEIGHT * curHV.length / (curHV.length + 3), 'a');
    if (histHV.length) blend1x2(mk, histHV, null, 'b');
  }
}

function modulateH2H(markets, rows, mode) {
  const H = rows;                 // perspectiva del local de hoy (todos los venues)
  const F = rows.map(flipRow);    // perspectiva del visitante de hoy
  // Totales y por-equipo (OU) + BTTS: VENUE-AGNÓSTICO (el total del partido no
  // depende de quién juega en casa) → usan todos los duelos.
  for (const fam of OU_FAMILIES) {
    modOU(markets[`${fam.key}_total`], H, fam.total, mode);
    modOU(markets[`${fam.key}_home`], H, fam.team, mode);
    modOU(markets[`${fam.key}_away`], F, fam.team, mode);
  }
  modBool(markets.btts, H, (r) => r.btts, mode);
  // CLEAN SHEET: "quién deja la valla a cero" depende de DÓNDE → solo duelos del
  // mismo venue que hoy (H de local = is_home en su perspectiva). El 1X2 se trata
  // aparte en apply1x2H2H (env H2H_1X2_MODE). OU y BTTS quedan agnósticos.
  const HV = H.filter((r) => r.is_home === true);  // duelos con H de local = venue de hoy
  const FV = HV.map(flipRow);                       // mismos duelos, perspectiva de A (visita)
  modBool(markets.clean_sheet_home, HV, (r) => r.clean_sheet, mode);
  modBool(markets.clean_sheet_away, FV, (r) => r.clean_sheet, mode);
}

// aplica la capa H2H a TODOS los mercados. Muta in-place y devuelve markets.
function applyH2H(markets, h2hRows, ctx) {
  if (!markets || !h2hRows || !h2hRows.length) return markets;
  const sameEd = (r) => Number(r.comp_id) === Number(ctx.competitionId) && Number(r.comp_season) === Number(ctx.season);
  const cur = h2hRows.filter(sameEd);            // modo (a): misma competición + temporada
  const hist = h2hRows.filter((r) => !sameEd(r)); // modo (b): el resto
  if (cur.length) modulateH2H(markets, cur, 'a');
  if (hist.length) modulateH2H(markets, hist, 'b');
  apply1x2H2H(markets['1x2'], cur, hist);   // 1X2 aparte (venue + H2H_1X2_MODE)
  return markets;
}

// ── capa de jugador (4C-2, rediseño multicanal) ──────────────────────────
// Se aplica DESPUÉS de applyH2H. Un titular habitual que hoy NO arranca desplaza
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
async function fetchPlayerContext(pool, fixtureId, ctx) {
  const cutoff = ctx.cutoff || new Date();
  const teams = [Number(ctx.homeTeamId), Number(ctx.awayTeamId)];
  const [lu, imp, sr, rl, homeRows, awayRows] = await Promise.all([
    pool.query(`SELECT player_id, is_starter FROM model.lineups WHERE fixture_id = $1`, [fixtureId]),
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

// ── orquestador de serving (4E) ───────────────────────────────────────────
// Cadena de serving: núcleo → [H2H si flag] → [jugador si flag]. Fuente de verdad para 4F.
// Banderas simétricas; el default codifica lo que sabemos:
//   • H2H APAGADO por defecto (MODEL_H2H_ENABLED==='true' para encender): el backtest 4E
//     (42.793 fixtures) mostró que EMPEORA el ECE (~1%→5-7%) por ruido de muestra chica de
//     los duelos directos (en liga, 2 enfrentamientos/temporada). Se CONSERVA tras el flag.
//   • JUGADOR ENCENDIDO por defecto (MODEL_PLAYER_ENABLED==='false' para apagar): aún sin
//     validar (fuera del backtest por la fuga de player_impact), pero sin evidencia de que
//     reste; auditable y trivial de apagar cuando se valide point-in-time.
// applyH2H/fetchH2HRows/applyPlayer se conservan; solo se invocan según el flag.
async function predict(pool, ctx, opts = {}) {
  const res = await computeBaseMarkets(pool, ctx, opts.cache ? { cache: opts.cache } : {});
  const h2hOn = opts.h2h != null ? !!opts.h2h : process.env.MODEL_H2H_ENABLED === 'true';              // default OFF
  const playerOn = opts.player != null ? !!opts.player : process.env.MODEL_PLAYER_ENABLED !== 'false'; // default ON
  let h2hRows = null, pctx = null;
  if (h2hOn) { h2hRows = await fetchH2HRows(pool, ctx.homeTeamId, ctx.awayTeamId, ctx.cutoff); applyH2H(res.markets, h2hRows, ctx); }
  if (playerOn) { pctx = await fetchPlayerContext(pool, ctx.fixtureId, ctx); applyPlayer(res.markets, pctx, ctx); }
  return { fixture: res.fixture, markets: res.markets, h2hRows, pctx, applied: { h2h: h2hOn, player: playerOn } };
}

module.exports = { computeBaseMarkets, fetchH2HRows, applyH2H, fetchPlayerContext, applyPlayer, computePlayerShifts, predict, tier, K };
