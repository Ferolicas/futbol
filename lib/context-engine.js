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

const { MARKET_DEFS } = require('./meta-features');
const { buildActuals } = require('./adn');
const { meetingRecord, h2hForMarket, exceptionCause, modalXIFromLineups } = require('./h2h');

// ── Constantes AFINABLES de la capa de excepciones / veto / confianza (Fase 4) ──
const VETO_ALPHA = 0.6;     // recorte de prob por ruptura presente hoy: prob·(1−α·rupture)
const VETO_TAU = 0.5;       // rupture_score ≥ τ → fuera de recomendados (aunque prob≥umbral)
const CONF_N0 = 12;         // soporte muestral para confianza media: n/(n+N0). n=8→0.40, n=64→0.84
const REC_THRESHOLD = 0.90; // umbral fijo de recomendación (diseño)
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
function scoreContext(contextOut, sctx = {}) {
  const { meetings = [], ctx = {}, modalXIByTeam = null, todayCtx = {}, homeId } = sctx;
  const meetingsById = new Map(meetings.map(m => [m.fixtureId, m]));
  const out = {};
  for (const [key, r] of Object.entries(contextOut)) {
    const { rupture, causes } = ruptureForMarket(r, meetingsById, ctx, modalXIByTeam, todayCtx, homeId);
    const prob_final = +(r.prob * (1 - VETO_ALPHA * rupture)).toFixed(6);
    const confidence = +(sampleWeight(r.n) * (1 - rupture)).toFixed(4);
    const recommended = prob_final >= REC_THRESHOLD && rupture < VETO_TAU;
    out[key] = { ...r, prob_final, rupture_score: +rupture.toFixed(4), confidence, recommended, causes };
  }
  return out;
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

  // 2) H2H del par (convención: ref_id=LEAST, sub_key=GREATEST).
  const lo = Math.min(homeId, awayId), hi = Math.max(homeId, awayId);
  const { rows: h2hRows } = await pool.query(
    `SELECT payload FROM raw_api_payloads WHERE endpoint='fixtures/headtohead' AND ref_id=$1 AND sub_key=$2`,
    [lo, String(hi)]
  );
  const h2hFx = (h2hRows[0]?.payload?.response) || [];

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
    ctx, modalXIByTeam,
    _counts: {
      homeFx: homeFx.length, awayFx: awayFx.length,
      homeFinished: homeRecords.length, awayFinished: awayRecords.length,
      meetingsRaw: h2hFx.length, meetings: meetings.length,
      lineups: luMap.size, injuries: injMap.size,
    },
  };
}

module.exports = {
  marketScope, rateFromRecords, l2ForMarket, computeContext,
  ruptureForMarket, scoreContext, sampleWeight, loadContextInputs,
  VETO_ALPHA, VETO_TAU, CONF_N0, REC_THRESHOLD, CAUSE_WEIGHT,
};
