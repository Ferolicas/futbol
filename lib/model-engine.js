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

module.exports = { computeBaseMarkets, fetchH2HRows, applyH2H, tier, K };
