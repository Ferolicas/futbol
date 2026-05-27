// ────────────────────────────────────────────────────────────────────────
// Núcleo del META-MODELO contextual (Fase 2).
//
// buildMetaFeatures() convierte (features_full + predictions_full + perfiles de
// equipo) en un VECTOR NUMÉRICO fijo. La MISMA función la usan el entrenador
// (scripts/train-meta-models.js) y el runtime (lib/contextual-calibration.js)
// → paridad train/score.
//
// El vector tiene slots GENÉRICOS (iguales para todos los mercados); lo que
// cambia por mercado es qué probabilidad base y qué métrica de ADN se enchufan
// en los slots `home_profile`/`away_profile` (ver MARKET_DEFS).
//
// CommonJS: usable por scripts node (require) y por Next (import dinámico).
// ────────────────────────────────────────────────────────────────────────

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const logit = (p) => { const x = clamp(p, 0.001, 0.999); return Math.log(x / (1 - x)); };
const num = (v) => (v == null || !isFinite(v) ? null : Number(v));

// Orden canónico de features del vector (estandarizadas en el entrenamiento).
const FEATURE_ORDER = [
  'base_logit',      // logit de la prob base (salida actual del sistema)
  'implied_logit',   // logit de la prob implícita de la cuota (0 si ausente)
  'implied_avail',   // 1 si hay cuota
  'home_profile',    // ADN del local en este mercado (tasa o promedio)
  'away_profile',    // ADN del visitante
  'profile_support', // log(1+min(n_local,n_visit)) — soporte muestral del ADN
  'pos_gap',         // (posVisitante - posLocal)/10
  'home_ppg', 'away_ppg',       // puntos por partido L5 /3
  'home_streak', 'away_streak', // racha /5
  'knockout', 'final',          // flags de fase
  'home_keyout', 'away_keyout', // bajas clave (count)
  'home_xgdiff', 'away_xgdiff', // diferencia de xG L5
  'xg_avail',                   // 1 si hay xG
];

// Catálogo de mercados del meta-modelo. baseProb/outcome/gate idénticos a los
// de build-calibration.js; homeMetric/awayMetric mapean al ADN de equipo.
const MARKET_DEFS = {
  home_win: { baseProb: p => p?.winner?.home, outcome: a => a?.result === 'H', gate: a => a?.result != null, homeMetric: 'homeWinRate',  awayMetric: 'awayLossRate' },
  draw:     { baseProb: p => p?.winner?.draw, outcome: a => a?.result === 'D', gate: a => a?.result != null, homeMetric: 'drawRate',     awayMetric: 'drawRate' },
  away_win: { baseProb: p => p?.winner?.away, outcome: a => a?.result === 'A', gate: a => a?.result != null, homeMetric: 'homeLossRate', awayMetric: 'awayWinRate' },
  btts:     { baseProb: p => p?.btts,         outcome: a => a?.goals?.btts === true, gate: a => a?.goals?.btts != null, homeMetric: 'bttsRate', awayMetric: 'bttsRate' },
  over_2_5: { baseProb: p => p?.overUnder?.over25, outcome: a => a?.goals?.total != null && a.goals.total > 2.5, gate: a => a?.goals?.total != null, homeMetric: 'over25Rate', awayMetric: 'over25Rate' },
  total_corners_over_9_5: { baseProb: p => p?.corners?.over95, outcome: a => a?.corners?.total != null && a.corners.total > 9.5, gate: a => a?.corners?.total != null, homeMetric: 'cornersForAvg', awayMetric: 'cornersForAvg' },
  total_cards_over_4_5:   { baseProb: p => p?.cards?.over45,   outcome: a => a?.cards?.total != null && a.cards.total > 4.5,   gate: a => a?.cards?.total != null, homeMetric: 'cardsForAvg',   awayMetric: 'cardsForAvg' },
};

// Lee la prob base (0-100 en predictions_full) → 0-1.
function baseProb01(def, predictionsFull) {
  const v = num(def.baseProb(predictionsFull));
  return v == null ? null : clamp(v / 100, 0.001, 0.999);
}

// Lee el shrunk_value + n de una métrica del perfil de equipo.
function profileVal(profileMap, metric) {
  const m = profileMap?.[metric];
  return { value: num(m?.shrunk_value), n: m?.sample_n || 0, consistency: num(m?.consistency) };
}

/**
 * Construye el vector de features para un mercado.
 * @returns {null | { base, features:{}, support:number, consistency:number, profileAvailable:boolean }}
 *   `base` = prob base 0-1 (para el baseline). `features` = slots numéricos
 *   (algunos null → el entrenador/ runtime imputan con la media).
 */
function buildMetaFeatures({ featuresFull, predictionsFull, homeProfile, awayProfile, market }) {
  const def = MARKET_DEFS[market];
  if (!def) return null;
  const base = baseProb01(def, predictionsFull);
  if (base == null) return null;

  const f = featuresFull || {};
  const mk = f.market || {};
  const impliedHome = num(mk.home);
  // prob implícita relevante: para 1X2 usamos la del lado; para el resto, la del
  // favorito local como proxy de fuerza (el peso lo aprende el modelo).
  const impliedForMarket =
    market === 'home_win' ? num(mk.home) :
    market === 'draw'     ? num(mk.draw) :
    market === 'away_win' ? num(mk.away) : impliedHome;

  const hp = profileVal(homeProfile, def.homeMetric);
  const ap = profileVal(awayProfile, def.awayMetric);
  const support = Math.min(hp.n, ap.n);

  const cz = f.causality || {};
  const formH = f.form?.home || {}; const formA = f.form?.away || {};
  const stH = f.state?.home || {};  const stA = f.state?.away || {};
  const comp = f.competition || {};

  const features = {
    base_logit:      logit(base),
    implied_logit:   (mk.available && impliedForMarket != null) ? logit(impliedForMarket) : 0,
    implied_avail:   (mk.available && impliedForMarket != null) ? 1 : 0,
    home_profile:    hp.value,
    away_profile:    ap.value,
    profile_support: Math.log1p(support),
    pos_gap:         f.table?.positionGap != null ? clamp(f.table.positionGap / 10, -2, 2) : null,
    home_ppg:        formH.ppg != null ? formH.ppg / 3 : null,
    away_ppg:        formA.ppg != null ? formA.ppg / 3 : null,
    home_streak:     formH.streak != null ? clamp(formH.streak / 5, -1, 1) : null,
    away_streak:     formA.streak != null ? clamp(formA.streak / 5, -1, 1) : null,
    knockout:        comp.isKnockout ? 1 : 0,
    final:           comp.isFinal ? 1 : 0,
    home_keyout:     stH.keyAttackersOut != null ? stH.keyAttackersOut : null,
    away_keyout:     stA.keyAttackersOut != null ? stA.keyAttackersOut : null,
    home_xgdiff:     cz.home?.xgDiffAvg != null ? cz.home.xgDiffAvg : null,
    away_xgdiff:     cz.away?.xgDiffAvg != null ? cz.away.xgDiffAvg : null,
    xg_avail:        (cz.home?.xgAvailable || cz.away?.xgAvailable) ? 1 : 0,
  };

  const consistency = Math.min(hp.consistency ?? 0, ap.consistency ?? 0);
  return { base, features, support, consistency, profileAvailable: hp.value != null && ap.value != null };
}

// Aplica un meta-modelo logístico (weights de prediction_models) a un vector de
// features. MISMA imputación+estandarización que el entrenamiento → paridad.
// Compartida por train-meta-models.js (validación) y el runtime contextual.
function predictWithModel(model, features) {
  if (!model || !model.features) return null;
  let z = model.bias || 0;
  for (const fn of model.features) {
    const raw = features[fn];
    const v = (raw == null || !isFinite(raw)) ? model.means[fn] : raw;
    const std = model.stds[fn] || 1;
    z += (model.coefs[fn] || 0) * ((v - model.means[fn]) / std);
  }
  return 1 / (1 + Math.exp(-z));
}

module.exports = { buildMetaFeatures, predictWithModel, MARKET_DEFS, FEATURE_ORDER, logit, clamp };
