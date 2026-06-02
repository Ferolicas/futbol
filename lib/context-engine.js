/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Motor de contexto (Fase 3). Por cada mercado y partido calcula la FRECUENCIA
// empírica real en el contexto MÁS ESPECÍFICO con datos:
//
//   L1 — H2H exacto: cruces reales entre los dos equipos (fixtures/headtohead)
//        orientados a los equipos de HOY, prob = hits/n. SIN mínimo de muestra.
//   L2 — ADN (si no hay H2H): tasa por línea desde los registros crudos de cada
//        equipo (local→partidos en casa, visitante→partidos fuera), combinada por
//        PROMEDIO PONDERADO POR MUESTRA. Algebraicamente eso es la tasa AGRUPADA
//        (hits_loc+hits_vis)/(n_loc+n_vis) → se "poolean" los registros. Mercados
//        TOTALES combinan ambos equipos; INDIVIDUALES solo el equipo del lado.
//   Sin L3 — sin H2H ni ADN: el mercado NO existe para ese partido (jamás se
//        inventa un número).
//
// Salida por mercado: { prob (0-1), level:'h2h'|'adn', n, hits, exceptions[] }.
//
// computeContext() es PURO (recibe inputs ya cargados) → mismo evaluador
// (MARKET_DEFS.outcome/gate sobre buildActuals) que el entrenamiento.
// loadContextInputs() arma esos inputs desde raw_api_payloads (lo usa el script
// de verificación y, en Fase 6, el runtime cacheado). CommonJS.
// ────────────────────────────────────────────────────────────────────────

const { MARKET_DEFS, predictWithModel } = require('./meta-features');
const { buildActuals, recordFromRaw, computeMetrics, filterSegment } = require('./adn');
const { meetingRecord, h2hForMarket, exceptionCause, modalXIFromLineups } = require('./h2h');

// ── Constantes AFINABLES de la capa de excepciones / veto / confianza (Fase 4) ──
const VETO_ALPHA = 0.6;     // recorte de prob por ruptura presente hoy: prob·(1−α·rupture)
const VETO_TAU = 0.5;       // rupture_score ≥ τ → fuera de recomendados (aunque prob≥umbral)
const CONF_N0 = 12;         // soporte muestral para confianza media: n/(n+N0). n=8→0.40, n=64→0.84
const REC_THRESHOLD = 0.90; // umbral fijo de recomendación (diseño)
// Piso de confianza para recomendar (Fase 5), DISTINTO por nivel:
//   H2H — cruces directos entre ESTOS equipos: valioso aun con muestra chica →
//         basta n ≥ MIN_H2H_N (3 enfrentamientos reales).
//   ADN — tasa agregada: una muestra chica en un mercado raro es RUIDO → exige
//         confidence ≥ MIN_ADN_CONFIDENCE (0.60 ≈ n≥18 sin ruptura).
const MIN_H2H_N = 3;
const MIN_ADN_CONFIDENCE = 0.60;
// Filtro de "líneas con sentido" (Fase 6a): un over/under (o hándicap) solo es
// recomendable si su línea está cerca de la MEDIA REAL del partido. Evita
// inundar con líneas triviales (under 20.5 goles = 100% pero cuota ~1.01). La
// cuota real ≥1.20 termina de filtrar en la combinada en vivo; esto limpia el
// listado offline y evita malgastar cómputo. ±LINE_BAND alrededor de la media.
const LINE_BAND = 3.5;

// ── ML detector de ruptura (Fase 6b) — gated por CONTEXT_ML_ENABLED ──
const RECENT_N_FORM = 6;
// Orden canónico de features del ML. COMPARTIDO entre el trainer y el runtime
// (paridad train↔score). ADN empírico crudo (Opción A, sin shrink).
const ML_FEATURE_ORDER = ['adn_home', 'adn_away', 'home_ppg', 'away_ppg', 'knockout', 'key_injury', 'h2h_rate', 'h2h_n', 'exception_rate'];
// ── Modelos AGREGADOS DIRECCIONALES por FAMILIA+SENTIDO ──────────────────────
// El efecto de key_injury/knockout es DIRECCIONAL (p.ej. ki sube P(over) y baja
// P(under)). Un solo modelo de error lo cancela. Solución: agrupar mercados que se
// mueven en el MISMO sentido (familia+sentido) y estimar el desplazamiento de
// log-odds (βki, βko) pooled por grupo. En runtime se aplica con SIGNO sobre la
// prob del motor. MISMA función de grupo en train↔runtime (paridad).
function marketFamily(k) {
  if (/^total_goals_/.test(k)) return 'goles_total';
  if (/^home_goals_/.test(k)) return 'goles_local';
  if (/^away_goals_/.test(k)) return 'goles_visit';
  if (/^btts/.test(k)) return 'btts';
  if (/^first_goal_/.test(k)) return 'primer_gol';
  if (/^goal_\d/.test(k)) return 'timing_gol';
  if (/^winner_1h/.test(k)) return 'resultado_1h';
  if (/^winner_2h/.test(k)) return 'resultado_2h';
  if (/cards?/.test(k)) return 'tarjetas';
  if (/corner/.test(k)) return 'corners';
  if (/foul/.test(k)) return 'faltas';
  if (/shot|sot/.test(k)) return 'tiros';
  if (/offside/.test(k)) return 'offsides';
  if (/^(home_win|away_win|draw)$/.test(k)) return 'resultado';
  if (/^ah_/.test(k)) return 'handicap';
  if (/^most_/.test(k)) return 'most_x';
  if (/^red_card/.test(k)) return 'roja';
  return 'otros';
}
function marketSense(k) {
  if (/_over\d/.test(k)) return 'over';
  if (/_under\d/.test(k)) return 'under';
  if (k === 'btts') return 'yes';
  if (k === 'btts_no') return 'no';
  if (/_home$/.test(k) || k === 'home_win') return 'home';
  if (/_away$/.test(k) || k === 'away_win') return 'away';
  if (/_draw$/.test(k) || k === 'draw') return 'draw';
  if (/^first_goal_/.test(k)) return 'early';
  if (/^goal_\d/.test(k)) return 'window';
  if (/^red_card/.test(k)) return 'yes';
  return 'x';
}
function marketGroup(k) { return `${marketFamily(k)}:${marketSense(k)}`; }
const _flogit = (p) => { const c = Math.max(1e-6, Math.min(1 - 1e-6, p)); return Math.log(c / (1 - c)); };
const _fsig = (z) => 1 / (1 + Math.exp(-z));

function recentPPG(recs) {
  const r = recs.slice(-RECENT_N_FORM);
  if (!r.length) return null;
  const pts = r.reduce((s, x) => s + (x.result === 'W' ? 3 : x.result === 'D' ? 1 : 0), 0);
  return pts / r.length / 3; // 0-1
}

// Precómputo POR PARTIDO (una vez): records filtrados point-in-time + métricas de
// segmento + flags de hoy. Compartido train↔runtime; se reusa en todos los
// mercados del partido (evita recalcular computeMetrics por mercado).
function ruptureContext({ homeTeamRecords = [], awayTeamRecords = [], todayCtx = {}, beforeMs = Date.now() }) {
  const before = (recs) => recs.filter(r => r && r.date && new Date(r.date).getTime() < beforeMs)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const hRecs = before(homeTeamRecords), aRecs = before(awayTeamRecords);
  return {
    hRecs, aRecs,
    homeMetrics: computeMetrics(filterSegment(hRecs, 'home')),
    awayMetrics: computeMetrics(filterSegment(aRecs, 'away')),
    home_ppg: recentPPG(hRecs), away_ppg: recentPPG(aRecs),
    knockout: todayCtx.knockout ? 1 : 0, key_injury: todayCtx.keyInjury ? 1 : 0,
  };
}

// Features POINT-IN-TIME del ML para UN mercado. MISMA función en entrenamiento
// y runtime → paridad exacta. `rc` = ruptureContext precomputado del partido.
// (Lo único por-mercado es la métrica de ADN seleccionada y el H2H del mercado.)
function buildRuptureFeatures({ def, market, rc, meetings = [], homeId, awayId, beforeMs = Date.now() }) {
  const h2h = h2hForMarket(meetings, market, homeId, awayId, beforeMs);
  return {
    adn_home: def?.homeMetric ? (rc.homeMetrics[def.homeMetric]?.emp ?? null) : null,
    adn_away: def?.awayMetric ? (rc.awayMetrics[def.awayMetric]?.emp ?? null) : null,
    home_ppg: rc.home_ppg,
    away_ppg: rc.away_ppg,
    knockout: rc.knockout,
    key_injury: rc.key_injury,
    h2h_rate: h2h.rate,
    h2h_n: Math.log1p(h2h.n || 0),
    exception_rate: h2h.n ? h2h.exceptions.length / h2h.n : null,
  };
}

// key_injury = ¿hay un lesionado que pertenece al XI HABITUAL (modal XI) de su
// equipo? Señal limpia (no "cualquier lesión"). MISMO criterio en train y runtime
// → paridad. `injuries` = lista cruda /injuries [{player:{id}, team:{id}}] (o
// {response:[...]}); `modalXIByTeam` = Map<teamId, Set<playerId>>.
function isKeyInjury(injuries, modalXIByTeam) {
  const arr = Array.isArray(injuries) ? injuries : (injuries?.response || []);
  if (!arr.length || !modalXIByTeam) return false;
  for (const inj of arr) {
    const tid = inj?.team?.id, pid = inj?.player?.id;
    if (pid == null) continue;
    const set = modalXIByTeam.get(tid);
    if (set && set.has(pid)) return true;
  }
  return false;
}

// Carga (cacheada) los modelos rupture-logistic ACTIVOS → Map market_key→weights.
const ML_CACHE_TTL = 60 * 60 * 1000;
let _mlCache = null, _mlCacheAt = 0;
async function loadRuptureModels(pool) {
  const now = Date.now();
  if (_mlCache && now - _mlCacheAt < ML_CACHE_TTL) return _mlCache;
  try {
    const { rows } = await pool.query(
      `SELECT market_key, weights FROM prediction_models
       WHERE sport='football' AND active=TRUE AND model_type='rupture-logistic'`
    );
    _mlCache = new Map(rows.map(r => [r.market_key, r.weights]));
  } catch { _mlCache = new Map(); }
  _mlCacheAt = Date.now();
  return _mlCache;
}
// Carga (cacheada) los modelos DIRECCIONALES por familia → Map group→{ki,ko}.
let _famCache = null, _famCacheAt = 0;
async function loadFamilyModels(pool) {
  const now = Date.now();
  if (_famCache && now - _famCacheAt < ML_CACHE_TTL) return _famCache;
  try {
    const { rows } = await pool.query(
      `SELECT market_key, weights FROM prediction_models
       WHERE sport='football' AND active=TRUE AND model_type='family-directional'`
    );
    _famCache = new Map(rows.map(r => [r.market_key, r.weights]));
  } catch { _famCache = new Map(); }
  _famCacheAt = Date.now();
  return _famCache;
}
// Desplazamiento de prob CON SIGNO por contexto adverso, vía el modelo direccional
// del grupo del mercado. ki/ko presentes → suma βki/βko en log-odds. Devuelve la
// prob ajustada (puede SUBIR o BAJAR según los datos). Sin contexto → prob igual.
function applyFamilyShift(familyModels, key, prob, keyInjury, knockout) {
  if (!familyModels || prob <= 0 || prob >= 1) return prob;
  const fm = familyModels.get(marketGroup(key));
  if (!fm) return prob;
  const shift = (keyInjury ? (fm.ki || 0) : 0) + (knockout ? (fm.ko || 0) : 0);
  if (shift === 0) return prob;
  return _fsig(_flogit(prob) + shift);
}
function _resetMlCache() { _mlCache = null; _mlCacheAt = 0; _famCache = null; _famCacheAt = 0; }
// Peso de cada causa de ruptura (keyInjury/knockout fuertes; venue débil; earlyRed
// casi no anticipable). rupture = máx_c (peso_c · prevalencia_c · presente_hoy_c).
const CAUSE_WEIGHT = { keyInjury: 1.0, knockout: 0.9, rotation: 0.8, venueAway: 0.4, earlyRed: 0.3 };

const sampleWeight = (n) => n / (n + CONF_N0);

// scope de un mercado:
//   'home'  → equipo local en sus partidos COMO LOCAL
//   'away'  → equipo visitante en sus partidos COMO VISITANTE
//   'total' → combina ambos segmentos (mercado de partido, no de lado)
function marketScope(key, def) {
  const fam = def.family || key;
  if (fam.startsWith('home_') || key.startsWith('home_')) return 'home';
  if (fam.startsWith('away_') || key.startsWith('away_')) return 'away';
  if (def.side === 'home') return 'home';
  if (def.side === 'away') return 'away';
  return 'total';
}

// Tasa de un mercado sobre un conjunto de registros [{actuals}], contando solo
// los que pasan el gate (datos disponibles para ese mercado en ese partido).
function rateFromRecords(records, def) {
  let n = 0, hits = 0;
  for (const r of records) {
    const a = r.actuals;
    if (!a || !def.gate(a)) continue;
    n++;
    if (def.outcome(a)) hits++;
  }
  return { n, hits, rate: n ? hits / n : null };
}

// L2 ADN por mercado. Pool de registros según scope (= promedio ponderado).
function l2ForMarket(key, def, homeHome, awayAway) {
  const scope = marketScope(key, def);
  const recs = scope === 'home' ? homeHome
             : scope === 'away' ? awayAway
             : homeHome.concat(awayAway); // total → pooled (ponderado por muestra)
  const { n, hits, rate } = rateFromRecords(recs, def);
  return n > 0 ? { prob: rate, level: 'adn', n, hits, exceptions: [] } : null;
}

/**
 * Cómputo principal del contexto de un partido.
 * @param {object} inp
 *   homeId, awayId
 *   meetings:     meetingRecord[] del par H2H (orientables a hoy)
 *   homeRecords:  [{ venue:'home'|'away', actuals }] partidos del local
 *   awayRecords:  [{ venue:'home'|'away', actuals }] partidos del visitante
 * @returns {{ [market_key]: { prob, level, n, hits, exceptions } }}
 *   Solo los mercados CON datos (L1 o L2). Los demás no aparecen (sin L3).
 */
function computeContext({ homeId, awayId, meetings = [], homeRecords = [], awayRecords = [] }) {
  const homeHome = homeRecords.filter(r => r.venue === 'home');
  const awayAway = awayRecords.filter(r => r.venue === 'away');
  const out = {};
  for (const [key, def] of Object.entries(MARKET_DEFS)) {
    // L1 — H2H exacto (sin mínimo). h2hForMarket orienta cada cruce a hoy,
    // evalúa el mismo def.outcome/gate y devuelve rate/n + excepciones (minoría).
    const h2h = h2hForMarket(meetings, key, homeId, awayId, null);
    if (h2h.n > 0) {
      out[key] = { prob: h2h.rate, level: 'h2h', n: h2h.n, hits: Math.round(h2h.rate * h2h.n), exceptions: h2h.exceptions };
      continue;
    }
    // L2 — ADN.
    const l2 = l2ForMarket(key, def, homeHome, awayAway);
    if (l2) out[key] = l2;
    // Sin datos → no se añade (sin L3).
  }
  return out;
}

// ── Excepciones + rupture_score de UN mercado (solo aplica a L1 H2H, que tiene
//    excepciones por minoría). Descompone la causa de los cruces que ROMPIERON
//    el patrón y mide cuánto coincide con el contexto de HOY. ──
function ruptureForMarket(r, meetingsById, ctx, modalXIByTeam, todayCtx, todayHomeId) {
  const exc = (r && r.exceptions) || [];
  if (r.level !== 'h2h' || !exc.length) return { rupture: 0, causes: {} };
  const agg = { earlyRed: 0, knockout: 0, rotation: 0, keyInjury: 0, venueAway: 0 };
  let counted = 0;
  for (const e of exc) {
    const m = meetingsById.get(e.fixtureId);
    if (!m) continue;
    counted++;
    const c = exceptionCause(e.fixtureId, ctx, todayHomeId, modalXIByTeam && modalXIByTeam.get(todayHomeId), m);
    if (c.earlyRed) agg.earlyRed++;
    if (c.knockout) agg.knockout++;
    if (c.rotation) agg.rotation++;
    if (c.keyInjury) agg.keyInjury++;
    // venueAway: el quiebre ocurrió cuando el LOCAL de hoy jugaba FUERA (venue
    // adverso). Solo es "ruptura presente hoy" si hoy el local también juega
    // fuera (raro) → por defecto NO veta un partido en casa; queda diagnóstico.
    if (m.homeId !== todayHomeId) agg.venueAway++;
  }
  if (!counted) return { rupture: 0, causes: {} };
  const present = {
    earlyRed: todayCtx.earlyRedRisk || 0,    // ~0: no se anticipa una roja temprana
    knockout: todayCtx.knockout ? 1 : 0,
    rotation: todayCtx.rotationRisk || 0,
    keyInjury: todayCtx.keyInjury ? 1 : 0,
    venueAway: todayCtx.homeTeamAway ? 1 : 0, // default 0 → no veta partidos en casa
  };
  let rupture = 0; const causes = {};
  for (const k of Object.keys(agg)) {
    const prevalence = agg[k] / counted;
    const score = (CAUSE_WEIGHT[k] || 0) * prevalence * present[k];
    causes[k] = { prevalence, presentToday: present[k], weight: CAUSE_WEIGHT[k] || 0, score };
    if (score > rupture) rupture = score;
  }
  return { rupture, causes };
}

/**
 * Capa de excepciones + veto + confianza (Fase 4). Toma la salida de
 * computeContext y la AUMENTA por mercado con:
 *   prob_final  = prob · (1 − α·rupture_score)
 *   rupture_score [0-1]
 *   confidence  = sampleWeight(n) · (1 − rupture_score)   (n bajo → menos confianza)
 *   recommended = prob_final ≥ REC_THRESHOLD AND rupture_score < τ
 *   causes      = desglose por causa
 *
 * sctx: { meetings, ctx:{events,lineups,injuries}, modalXIByTeam, todayCtx, homeId }
 *   todayCtx: { knockout, keyInjury, rotationRisk, earlyRedRisk }
 */
// Ternas EXHAUSTIVAS (mutuamente excluyentes y completas) → su prob se
// renormaliza a sumar 1 desde las frecuencias reales.
const EXHAUSTIVE_TRIPLES = [
  ['home_win', 'draw', 'away_win'],
  ['winner_1h_home', 'winner_1h_draw', 'winner_1h_away'],
  ['winner_2h_home', 'winner_2h_draw', 'winner_2h_away'],
  ['most_corners_home', 'most_corners_draw', 'most_corners_away'],
  ['most_shots_home', 'most_shots_draw', 'most_shots_away'],
  ['most_fouls_home', 'most_fouls_draw', 'most_fouls_away'],
  ['most_corners_1h_home', 'most_corners_1h_draw', 'most_corners_1h_away'],
  ['most_corners_2h_home', 'most_corners_2h_draw', 'most_corners_2h_away'],
];

// Map key→prob normalizada para las ternas completas (1X2 a 100%, etc.).
function normalizedProbs(contextOut) {
  const norm = new Map();
  for (const triple of EXHAUSTIVE_TRIPLES) {
    if (!triple.every(k => contextOut[k])) continue;
    const sum = triple.reduce((s, k) => s + (contextOut[k].prob || 0), 0);
    if (sum > 0) for (const k of triple) norm.set(k, contextOut[k].prob / sum);
  }
  return norm;
}

// Piso de recomendación, DISTINTO por nivel (Fase 5): H2H con n≥MIN_H2H_N;
// ADN con confidence≥MIN_ADN_CONFIDENCE. Saca el ruido de muestra chica (ADN
// raro) sin matar los H2H legítimos (cruces directos, valiosos aun con n bajo).
function isRecommended(probFinal, rupture, level, n, confidence) {
  if (probFinal < REC_THRESHOLD) return false;
  if (rupture >= VETO_TAU) return false;
  if (level === 'h2h') return n >= MIN_H2H_N;
  if (level === 'adn') return confidence >= MIN_ADN_CONFIDENCE;
  return false;
}

// Media REAL por grupo over/under, desde los registros del partido (segmento:
// total = local-en-casa + visitante-fuera; individuales = el equipo del lado).
function computeGroupMeans(homeRecords = [], awayRecords = []) {
  const hh = homeRecords.filter(r => r.venue === 'home').map(r => r.actuals).filter(Boolean);
  const aa = awayRecords.filter(r => r.venue === 'away').map(r => r.actuals).filter(Boolean);
  const pool = [...hh, ...aa];
  const mean = (arr, f) => { const v = arr.map(f).filter(x => x != null && isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const m = {};
  m.total_goals = mean(pool, a => a.goals?.total);       m.total_corners = mean(pool, a => a.corners?.total);
  m.total_cards = mean(pool, a => a.cards?.total);        m.total_shots = mean(pool, a => a.shots?.total);
  m.total_sot = mean(pool, a => a.shots?.totalOnTarget); m.total_fouls = mean(pool, a => a.fouls?.total);
  m.total_offsides = mean(pool, a => a.offsides?.total);
  m.total_goals_1h = mean(pool, a => a.goals1H?.total);  m.total_goals_2h = mean(pool, a => a.goals2H?.total);
  m.total_cards_1h = mean(pool, a => a.cardsByHalf?.firstHalf?.total);  m.total_cards_2h = mean(pool, a => a.cardsByHalf?.secondHalf?.total);
  m.total_corners_1h = mean(pool, a => a.half?.firstHalf?.corners?.total); m.total_corners_2h = mean(pool, a => a.half?.secondHalf?.corners?.total);
  m.total_shots_1h = mean(pool, a => a.half?.firstHalf?.shots?.total);  m.total_shots_2h = mean(pool, a => a.half?.secondHalf?.shots?.total);
  m.total_sot_1h = mean(pool, a => a.half?.firstHalf?.sot?.total);      m.total_sot_2h = mean(pool, a => a.half?.secondHalf?.sot?.total);
  m.total_fouls_1h = mean(pool, a => a.half?.firstHalf?.fouls?.total);  m.total_fouls_2h = mean(pool, a => a.half?.secondHalf?.fouls?.total);
  m.home_goals = mean(hh, a => a.goals?.home);     m.away_goals = mean(aa, a => a.goals?.away);
  m.home_corners = mean(hh, a => a.corners?.home); m.away_corners = mean(aa, a => a.corners?.away);
  m.home_cards = mean(hh, a => a.cards?.home);     m.away_cards = mean(aa, a => a.cards?.away);
  m.home_shots = mean(hh, a => a.shots?.home);     m.away_shots = mean(aa, a => a.shots?.away);
  m.home_fouls = mean(hh, a => a.fouls?.home);     m.away_fouls = mean(aa, a => a.fouls?.away);
  m.home_offsides = mean(hh, a => a.offsides?.home); m.away_offsides = mean(aa, a => a.offsides?.away);
  m.home_goals_1h = mean(hh, a => a.goals1H?.home); m.away_goals_1h = mean(aa, a => a.goals1H?.away);
  m.home_goals_2h = mean(hh, a => a.goals2H?.home); m.away_goals_2h = mean(aa, a => a.goals2H?.away);
  m.home_corners_1h = mean(hh, a => a.half?.firstHalf?.corners?.home); m.away_corners_1h = mean(aa, a => a.half?.firstHalf?.corners?.away);
  m.home_corners_2h = mean(hh, a => a.half?.secondHalf?.corners?.home); m.away_corners_2h = mean(aa, a => a.half?.secondHalf?.corners?.away);
  m._goalDiff = (m.home_goals != null && m.away_goals != null) ? (m.home_goals - m.away_goals) : null;
  return m;
}

// ¿La línea de un over/under (o hándicap) está cerca de la media real? Los
// escalares (1X2, BTTS, más-X, roja, primer gol, ganador por mitad) no filtran.
function isTradeableLine(key, means) {
  if (!means) return true;
  const ou = key.match(/^(.+)_(over|under)(\d+)_5$/);
  if (ou) {
    const mean = means[ou[1]];
    if (mean == null) return true;
    const line = parseInt(ou[3], 10) + 0.5;
    return Math.abs(line - mean) <= LINE_BAND;
  }
  const ah = key.match(/^ah_(home|away)_([mp])(\d+)_(\d+)$/);
  if (ah) {
    if (means._goalDiff == null) return true;
    const L = (ah[2] === 'm' ? -1 : 1) * parseFloat(`${ah[3]}.${ah[4]}`);
    const center = ah[1] === 'home' ? -means._goalDiff : means._goalDiff;
    return Math.abs(L - center) <= LINE_BAND;
  }
  return true;
}

function scoreContext(contextOut, sctx = {}) {
  const {
    meetings = [], ctx = {}, modalXIByTeam = null, todayCtx = {}, homeId, awayId,
    homeRecords, awayRecords, homeTeamRecords, awayTeamRecords, mlModels = null, mlEnabled = false,
    familyModels = null,
  } = sctx;
  const meetingsById = new Map(meetings.map(m => [m.fixtureId, m]));
  const normP = normalizedProbs(contextOut);
  const means = (homeRecords || awayRecords) ? computeGroupMeans(homeRecords, awayRecords) : null;
  const useMl = mlEnabled && ((mlModels && mlModels.size > 0) || (familyModels && familyModels.size > 0));
  // Precómputo del contexto ML una sola vez para el partido (se reusa en todos
  // los mercados con modelo activo).
  const rc = (useMl && mlModels && mlModels.size > 0) ? ruptureContext({ homeTeamRecords, awayTeamRecords, todayCtx, beforeMs: Date.now() }) : null;
  const kiNow = !!todayCtx.keyInjury, koNow = !!todayCtx.knockout;
  const useFamily = !!(useMl && familyModels && familyModels.size > 0 && (kiNow || koNow));
  const out = {};
  for (const [key, r] of Object.entries(contextOut)) {
    const prob = normP.has(key) ? normP.get(key) : r.prob;   // 1X2/ternas → normalizada
    const { rupture: ruptureH2H, causes } = ruptureForMarket(r, meetingsById, ctx, modalXIByTeam, todayCtx, homeId);

    // Capa ML (gated): si hay modelo activo para el mercado, su predicción
    // CONTEXTUAL modula la ruptura. ml_rupture = cuánto el contexto rebaja el
    // outcome respecto a la frecuencia real (0 si el ML lo ve igual o mejor).
    // Combinación soft-OR: complementa la causa H2H, no la reemplaza.
    let ruptureMl = 0;
    if (useMl && prob > 0 && mlModels && mlModels.has(key)) {
      try {
        const feats = buildRuptureFeatures({ def: MARKET_DEFS[key], market: key, rc, meetings, homeId, awayId, beforeMs: Date.now() });
        const mlPred = predictWithModel(mlModels.get(key), feats);
        if (mlPred != null && isFinite(mlPred)) ruptureMl = Math.max(0, Math.min(1, 1 - mlPred / prob));
      } catch { /* sin ML para este mercado */ }
    }
    const rupture = ruptureMl > 0 ? (1 - (1 - ruptureH2H) * (1 - ruptureMl)) : ruptureH2H;

    // Ajuste DIRECCIONAL CON SIGNO por contexto adverso (sube o baja la prob según
    // los datos de la familia). Aplicado ANTES del recorte de fiabilidad (rupture).
    const probAdj = useFamily ? applyFamilyShift(familyModels, key, prob, kiNow, koNow) : prob;
    const prob_final = +(probAdj * (1 - VETO_ALPHA * rupture)).toFixed(6);
    const confidence = +(sampleWeight(r.n) * (1 - rupture)).toFixed(4);
    const tradeable = isTradeableLine(key, means);
    const recommended = tradeable && isRecommended(prob_final, rupture, r.level, r.n, confidence);
    out[key] = {
      ...r,
      prob: +prob.toFixed(6), prob_raw: r.prob, normalized: normP.has(key),
      prob_adj: +probAdj.toFixed(6), adverse_shift: +(probAdj - prob).toFixed(4),
      prob_final, rupture_score: +rupture.toFixed(4),
      rupture_h2h: +ruptureH2H.toFixed(4), rupture_ml: +ruptureMl.toFixed(4),
      confidence, tradeable, recommended, causes,
    };
  }

  // ── Doble oportunidad (DERIVADA del 1X2 normalizado) ──────────────────────
  // P(1X)=P(home)+P(draw), P(12)=P(home)+P(away), P(X2)=P(draw)+P(away). Es una
  // combinación lógica de resultados exhaustivos → hereda la calibración del 1X2
  // (no se entrena aparte). prob_final aplica el MISMO recorte por ruptura (la
  // mayor de los dos componentes); confianza = la menor (conservador). Fluye como
  // un mercado más por selectable/recommended/oddFor (campo de odds: doubleChance).
  const _w = { home: out.home_win, draw: out.draw, away: out.away_win };
  if (_w.home && _w.draw && _w.away) {
    const dcDef = (a, b) => {
      const probRaw = Math.min(0.999, (a.prob || 0) + (b.prob || 0));
      const rup = Math.max(a.rupture_score || 0, b.rupture_score || 0);
      const pf = +(probRaw * (1 - VETO_ALPHA * rup)).toFixed(6);
      const conf = +Math.min(a.confidence || 0, b.confidence || 0).toFixed(4);
      const n = Math.min(a.n || 0, b.n || 0);
      const level = a.level || b.level || 'adn';
      return {
        prob: +probRaw.toFixed(6), prob_raw: probRaw, normalized: true,
        prob_adj: +probRaw.toFixed(6), adverse_shift: 0,
        prob_final: pf, rupture_score: +rup.toFixed(4),
        rupture_h2h: +rup.toFixed(4), rupture_ml: 0,
        confidence: conf, tradeable: true,
        recommended: isRecommended(pf, rup, level, n, conf),
        n, level, derived: 'double_chance', causes: {},
      };
    };
    out.dc_1x = dcDef(_w.home, _w.draw);
    out.dc_12 = dcDef(_w.home, _w.away);
    out.dc_x2 = dcDef(_w.draw, _w.away);
  }

  // ── Portería a cero (EXACTO) ──────────────────────────────────────────────
  // clean_sheet_home = el LOCAL deja la valla a cero = el visitante marca 0 =
  // P(away_goals < 0.5). Misma prob que ese OU; cuota propia del mercado "Clean
  // Sheet". Hereda calibración de los goles por-equipo.
  const cloneDerived = (base, derived) => base ? {
    ...base, derived, causes: {},
    recommended: isRecommended(base.prob_final, base.rupture_score, base.level, base.n, base.confidence),
  } : null;
  if (out.away_goals_under0_5) out.clean_sheet_home = cloneDerived(out.away_goals_under0_5, 'clean_sheet');
  if (out.home_goals_under0_5) out.clean_sheet_away = cloneDerived(out.home_goals_under0_5, 'clean_sheet');

  // ── Sin empate / Draw No Bet (EXACTO) ─────────────────────────────────────
  // Renormaliza el 1X2 quitando el empate: P(home | no empate)=P(home)/(P(home)+P(away)).
  if (_w.home && _w.away) {
    const den = (_w.home.prob || 0) + (_w.away.prob || 0);
    if (den > 0) {
      const dnbDef = (winner) => {
        const probRaw = Math.min(0.999, (winner.prob || 0) / den);
        const rup = winner.rupture_score || 0;
        const pf = +(probRaw * (1 - VETO_ALPHA * rup)).toFixed(6);
        return {
          prob: +probRaw.toFixed(6), prob_raw: probRaw, normalized: true,
          prob_adj: +probRaw.toFixed(6), adverse_shift: 0,
          prob_final: pf, rupture_score: +rup.toFixed(4),
          rupture_h2h: +rup.toFixed(4), rupture_ml: 0,
          confidence: winner.confidence, tradeable: true,
          recommended: isRecommended(pf, rup, winner.level, winner.n, winner.confidence),
          n: winner.n, level: winner.level, derived: 'dnb', causes: {},
        };
      };
      out.dnb_home = dnbDef(_w.home);
      out.dnb_away = dnbDef(_w.away);
    }
  }

  // ── Derivados de la DISTRIBUCIÓN de goles + mitades ───────────────────────
  // Crea una entrada derivada heredando ruptura/confianza/nivel de `base` y
  // aplicando el mismo recorte por ruptura a la prob derivada.
  const mkDerived = (probRaw, base, derived) => {
    if (!base || probRaw == null || !isFinite(probRaw)) return null;
    const p = Math.max(0.001, Math.min(0.999, probRaw));
    const rup = base.rupture_score || 0;
    const pf = +(p * (1 - VETO_ALPHA * rup)).toFixed(6);
    return {
      prob: +p.toFixed(6), prob_raw: p, normalized: true, prob_adj: +p.toFixed(6), adverse_shift: 0,
      prob_final: pf, rupture_score: +rup.toFixed(4), rupture_h2h: +rup.toFixed(4), rupture_ml: 0,
      confidence: base.confidence, tradeable: true,
      recommended: isRecommended(pf, rup, base.level, base.n, base.confidence),
      n: base.n, level: base.level, derived, causes: {},
    };
  };
  // Distribución P(=k) desde el escalón over/under de una familia (EXACTO).
  const distFromLadder = (prefix, maxK = 12) => {
    const pov = (k) => { const e = out[`${prefix}_over${k}_5`]; return e ? (e.prob ?? null) : null; };
    if (pov(0) == null) return null;
    const P = [Math.max(0, 1 - pov(0))];
    for (let k = 1; k <= maxK; k++) {
      const a = pov(k - 1); if (a == null) break;
      const b = pov(k);
      P[k] = (b != null) ? Math.max(0, a - b) : Math.max(0, a);
      if (b == null) break;
    }
    return P;
  };
  const goalsBase = out.total_goals_over1_5 || out.total_goals_over2_5 || out.total_goals_over0_5 || null;
  const gd = distFromLadder('total_goals');
  if (gd && goalsBase) {
    // Par / Impar (normaliza por si la cola se truncó).
    let even = 0, odd = 0;
    for (let k = 0; k < gd.length; k++) (k % 2 === 0 ? (even += gd[k]) : (odd += gd[k]));
    const s = even + odd;
    if (s > 0) { out.goals_even = mkDerived(even / s, goalsBase, 'odd_even'); out.goals_odd = mkDerived(odd / s, goalsBase, 'odd_even'); }
    // Nº exacto de goles 0..6 y 7+.
    for (let k = 0; k <= 6; k++) if (gd[k] != null) out[`exact_goals_${k}`] = mkDerived(gd[k], goalsBase, 'exact_goals');
    const p7 = out.total_goals_over6_5?.prob; // P(>6.5) = P(≥7)
    if (p7 != null) out.exact_goals_7plus = mkDerived(p7, goalsBase, 'exact_goals');
  }
  // Ganar ambas mitades (independencia entre mitades — estándar del mercado).
  if (out.winner_1h_home && out.winner_2h_home)
    out.wbh_home = mkDerived((out.winner_1h_home.prob || 0) * (out.winner_2h_home.prob || 0), out.winner_1h_home, 'win_both_halves');
  if (out.winner_1h_away && out.winner_2h_away)
    out.wbh_away = mkDerived((out.winner_1h_away.prob || 0) * (out.winner_2h_away.prob || 0), out.winner_1h_away, 'win_both_halves');
  // Mitad con más goles (convolución de las distribuciones de goles por mitad).
  const d1 = distFromLadder('total_goals_1h', 6), d2 = distFromLadder('total_goals_2h', 6);
  if (d1 && d2 && goalsBase) {
    let p1 = 0, p2 = 0, pe = 0;
    for (let i = 0; i < d1.length; i++) for (let j = 0; j < d2.length; j++) { const pr = d1[i] * d2[j]; if (i > j) p1 += pr; else if (j > i) p2 += pr; else pe += pr; }
    const st = p1 + p2 + pe;
    if (st > 0) {
      out.hsh_1h = mkDerived(p1 / st, goalsBase, 'highest_scoring_half');
      out.hsh_2h = mkDerived(p2 / st, goalsBase, 'highest_scoring_half');
      out.hsh_draw = mkDerived(pe / st, goalsBase, 'highest_scoring_half');
    }
  }
  return out;
}

// ── Persistencia: guarda los 1133 mercados (recomendados o no) en
//    market_context_analysis (auditable). Upsert por (fixture_id, market_key).
async function persistFixtureContext(pool, fixtureId, date, scored) {
  const rows = Object.entries(scored).map(([market_key, r]) => ({
    market_key,
    prob: r.prob ?? null,
    prob_final: r.prob_final ?? null,
    level: r.level || null,
    sample_n: r.n ?? null,
    confidence: r.confidence ?? null,
    rupture_score: r.rupture_score ?? 0,
    recommended: !!r.recommended,
    exceptions: r.exceptions || [],
  }));
  if (!rows.length) return { written: 0 };
  await pool.query(
    `INSERT INTO market_context_analysis
       (fixture_id, market_key, prob, prob_final, level, sample_n, confidence, rupture_score, recommended, exceptions, date)
     SELECT $1, x.market_key, x.prob, x.prob_final, x.level, x.sample_n, x.confidence, x.rupture_score, x.recommended, x.exceptions, $2::date
     FROM jsonb_to_recordset($3::jsonb) AS x(market_key text, prob real, prob_final real, level text, sample_n int,
                                            confidence real, rupture_score real, recommended boolean, exceptions jsonb)
     ON CONFLICT (fixture_id, market_key) DO UPDATE SET
       prob=EXCLUDED.prob, prob_final=EXCLUDED.prob_final, level=EXCLUDED.level, sample_n=EXCLUDED.sample_n,
       confidence=EXCLUDED.confidence, rupture_score=EXCLUDED.rupture_score, recommended=EXCLUDED.recommended,
       exceptions=EXCLUDED.exceptions, date=EXCLUDED.date, updated_at=NOW()`,
    [fixtureId, date || null, JSON.stringify(rows)]
  );
  return { written: rows.length, recommended: rows.filter(r => r.recommended).length };
}

// ── Carga de inputs desde raw_api_payloads (pg Pool) ────────────────────────
// Devuelve { homeId, awayId, meetings, homeRecords, awayRecords, _counts }.
async function loadContextInputs(pool, homeId, awayId) {
  homeId = Number(homeId); awayId = Number(awayId);

  // 1) Fixtures de cada equipo (donde aparece como local o visitante).
  const teamFixtures = async (teamId) => {
    const { rows } = await pool.query(
      `SELECT payload FROM raw_api_payloads
       WHERE endpoint='fixtures'
         AND (payload->'teams'->'home'->>'id' = $1 OR payload->'teams'->'away'->>'id' = $1)`,
      [String(teamId)]
    );
    return rows.map(r => r.payload).filter(Boolean);
  };
  const [homeFx, awayFx] = await Promise.all([teamFixtures(homeId), teamFixtures(awayId)]);

  // 2) Cruces H2H — RECONSTRUIDOS del crudo de fixtures (robusto). El endpoint
  //    fixtures/headtohead devolvió [] para muchísimos pares reales (su captura
  //    enmascaró el rate-limit guardando un vacío "limpio"), así que NO se
  //    depende de él: los enfrentamientos entre estos dos equipos ya están en
  //    `fixtures` (se guardan al capturar la temporada de cada equipo). Se toman
  //    los fixtures donde juegan EXACTAMENTE estos dos, y se complementa con el
  //    payload de headtohead si existe (cruces de otras temporadas), uniendo por
  //    fixture id (gana el del crudo de fixtures, que trae stats/events).
  const isPair = (f) => {
    const h = f?.teams?.home?.id, a = f?.teams?.away?.id;
    return (h === homeId && a === awayId) || (h === awayId && a === homeId);
  };
  const lo = Math.min(homeId, awayId), hi = Math.max(homeId, awayId);
  const { rows: h2hRows } = await pool.query(
    `SELECT payload FROM raw_api_payloads WHERE endpoint='fixtures/headtohead' AND ref_id=$1 AND sub_key=$2`,
    [lo, String(hi)]
  );
  const h2hEndpointFx = (h2hRows[0]?.payload?.response) || [];
  const reconstructed = [...homeFx, ...awayFx].filter(isPair);
  const meetByFid = new Map();
  for (const f of [...h2hEndpointFx, ...reconstructed]) { const id = f?.fixture?.id; if (id) meetByFid.set(Number(id), f); }
  const h2hFx = [...meetByFid.values()];

  // 3) statistics / events / halfstats por fixture id (de todos los implicados).
  const fids = new Set();
  for (const f of [...homeFx, ...awayFx, ...h2hFx]) { const id = f?.fixture?.id; if (id) fids.add(Number(id)); }
  const idArr = [...fids];
  const loadByFid = async (endpoint) => {
    if (!idArr.length) return new Map();
    const { rows } = await pool.query(
      `SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint=$1 AND ref_id = ANY($2::bigint[])`,
      [endpoint, idArr]
    );
    return new Map(rows.map(r => [Number(r.ref_id), r.payload]));
  };
  const [stMap, evMap, hsMap, luMap] = await Promise.all([
    loadByFid('fixtures/statistics'),
    loadByFid('fixtures/events'),
    loadByFid('fixtures/halfstats'),
    loadByFid('fixtures/lineups'),
  ]);
  // Injuries por fixture (sub_key 'fx:<id>').
  const injMap = new Map();
  if (idArr.length) {
    const { rows: injRows } = await pool.query(
      `SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='injuries' AND sub_key LIKE 'fx:%' AND ref_id = ANY($1::bigint[])`,
      [idArr]
    );
    for (const r of injRows) injMap.set(Number(r.ref_id), r.payload);
  }

  const recOf = (teamId) => (f) => {
    const fid = Number(f?.fixture?.id);
    const a = buildActuals(f, stMap.get(fid) || null, evMap.get(fid) || null, hsMap.get(fid) || null);
    if (!a) return null;
    return { venue: (f.teams?.home?.id === teamId ? 'home' : 'away'), actuals: a };
  };
  const homeRecords = homeFx.map(recOf(homeId)).filter(Boolean);
  const awayRecords = awayFx.map(recOf(awayId)).filter(Boolean);
  // Records POR EQUIPO (recordFromRaw) para los features del ML (computeMetrics).
  const homeTeamRecords = homeFx.map(f => recordFromRaw(f, stMap.get(Number(f?.fixture?.id)) || null, homeId)).filter(Boolean);
  const awayTeamRecords = awayFx.map(f => recordFromRaw(f, stMap.get(Number(f?.fixture?.id)) || null, awayId)).filter(Boolean);
  const meetings = h2hFx
    .map(f => { const fid = Number(f?.fixture?.id); return meetingRecord(f, stMap.get(fid) || null, evMap.get(fid) || null, hsMap.get(fid) || null); })
    .filter(Boolean);

  // ctx (eventos/lineups/injuries por fixture) + XI modal por equipo para el
  // análisis de causas de las excepciones (Fase 4).
  const ctx = {
    events: Object.fromEntries(evMap),
    lineups: Object.fromEntries(luMap),
    injuries: Object.fromEntries(injMap),
  };
  const allLineups = [...luMap.values()];
  const modalXIByTeam = new Map([
    [homeId, modalXIFromLineups(allLineups, homeId)],
    [awayId, modalXIFromLineups(allLineups, awayId)],
  ]);

  return {
    homeId, awayId, meetings, homeRecords, awayRecords,
    homeTeamRecords, awayTeamRecords,
    ctx, modalXIByTeam,
    _counts: {
      homeFx: homeFx.length, awayFx: awayFx.length,
      homeFinished: homeRecords.length, awayFinished: awayRecords.length,
      meetingsRaw: h2hFx.length, meetings: meetings.length,
      meetingsReconstructed: reconstructed.length, meetingsEndpoint: h2hEndpointFx.length,
      lineups: luMap.size, injuries: injMap.size,
    },
  };
}

module.exports = {
  marketScope, rateFromRecords, l2ForMarket, computeContext,
  ruptureForMarket, scoreContext, sampleWeight, isRecommended, normalizedProbs,
  computeGroupMeans, isTradeableLine, persistFixtureContext, loadContextInputs,
  buildRuptureFeatures, ruptureContext, recentPPG, isKeyInjury, loadRuptureModels, _resetMlCache, ML_FEATURE_ORDER,
  loadFamilyModels, applyFamilyShift, marketGroup, marketFamily, marketSense,
  VETO_ALPHA, VETO_TAU, CONF_N0, REC_THRESHOLD, CAUSE_WEIGHT,
  MIN_H2H_N, MIN_ADN_CONFIDENCE, EXHAUSTIVE_TRIPLES, LINE_BAND,
};
