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
  // ── Nivel 2 — H2H específico vs este rival (point-in-time) ──
  'h2h_rate',        // tasa del mercado en cruces previos
  'h2h_n',           // log(1+nº de cruces) — soporte
  'h2h_blend',       // mezcla EB de h2h_rate con la base (pesa más con más n)
  // ── Nivel 3 — excepciones causales ──
  'exception_rate',  // fracción del histórico H2H que rompió el patrón
  'rupture_today',   // [0-1] una causa de ruptura pasada está presente HOY
  'today_rotation',  // riesgo de rotación hoy (congestión/calendario)
  'today_congestion',// 1 si descanso ≤3 días (local o visitante)
];

// Catálogo de mercados del meta-modelo — ESPEJO EXACTO de build-calibration.js
// (SCALAR + OU groups × líneas over/under K=0..20) para cubrir TODOS los
// mercados que el sistema recomienda, más la métrica de ADN por mercado
// (homeMetric/awayMetric). El gate de MIN_SAMPLES decide cuáles se entrenan.

const SCALAR_DEFS = {
  home_win: { baseProb: p => p?.winner?.home, outcome: a => a?.result === 'H', gate: a => a?.result != null, homeMetric: 'homeWinRate',  awayMetric: 'awayLossRate' },
  draw:     { baseProb: p => p?.winner?.draw, outcome: a => a?.result === 'D', gate: a => a?.result != null, homeMetric: 'drawRate',     awayMetric: 'drawRate' },
  away_win: { baseProb: p => p?.winner?.away, outcome: a => a?.result === 'A', gate: a => a?.result != null, homeMetric: 'homeLossRate', awayMetric: 'awayWinRate' },
  btts:     { baseProb: p => p?.btts,   outcome: a => a?.goals?.btts === true,  gate: a => a?.goals?.btts != null, homeMetric: 'bttsRate', awayMetric: 'bttsRate' },
  btts_no:  { baseProb: p => p?.bttsNo, outcome: a => a?.goals?.btts === false, gate: a => a?.goals?.btts != null, homeMetric: 'bttsRate', awayMetric: 'bttsRate' },
  first_goal_30: { baseProb: p => p?.firstGoal?.before30, outcome: a => a?.firstGoalMinute != null && a.firstGoalMinute <= 30, gate: a => a?.goals?.total != null, homeMetric: 'scoredRate', awayMetric: 'scoredRate' },
  first_goal_45: { baseProb: p => p?.firstGoal?.before45, outcome: a => a?.firstGoalMinute != null && a.firstGoalMinute <= 45, gate: a => a?.goals?.total != null, homeMetric: 'scoredRate', awayMetric: 'scoredRate' },
};

// Grupos over/under: probObj (de predictions_full) + actualValue (de actuals_full)
// idénticos a build-calibration.js; homeMetric/awayMetric = ADN relevante.
const OU_GROUP_DEFS = {
  total_goals:   { probObj: p => p?.overUnder, actualValue: a => a?.goals?.total,         homeMetric: 'goalsForAvg',     awayMetric: 'goalsForAvg' },
  total_corners: { probObj: p => p?.corners,   actualValue: a => a?.corners?.total,        homeMetric: 'cornersForAvg',   awayMetric: 'cornersForAvg' },
  total_cards:   { probObj: p => p?.cards,     actualValue: a => a?.cards?.total,          homeMetric: 'cardsForAvg',     awayMetric: 'cardsForAvg' },
  total_shots:   { probObj: p => p?.shots,     actualValue: a => a?.shots?.total,          homeMetric: 'shotsForAvg',     awayMetric: 'shotsForAvg' },
  total_sot:     { probObj: p => p?.sot,       actualValue: a => a?.shots?.totalOnTarget,  homeMetric: 'sotForAvg',       awayMetric: 'sotForAvg' },
  total_fouls:   { probObj: p => p?.fouls,     actualValue: a => a?.fouls?.total,          homeMetric: 'foulsForAvg',     awayMetric: 'foulsForAvg' },
  home_goals:    { probObj: p => p?.perTeam?.home?.goals,   actualValue: a => a?.goals?.home,   homeMetric: 'goalsForAvg',     awayMetric: 'goalsAgainstAvg' },
  away_goals:    { probObj: p => p?.perTeam?.away?.goals,   actualValue: a => a?.goals?.away,   homeMetric: 'goalsAgainstAvg', awayMetric: 'goalsForAvg' },
  home_corners:  { probObj: p => p?.perTeam?.home?.corners, actualValue: a => a?.corners?.home, homeMetric: 'cornersForAvg',   awayMetric: 'cornersAgainstAvg' },
  away_corners:  { probObj: p => p?.perTeam?.away?.corners, actualValue: a => a?.corners?.away, homeMetric: 'cornersAgainstAvg', awayMetric: 'cornersForAvg' },
  home_cards:    { probObj: p => p?.perTeam?.home?.cards,   actualValue: a => a?.cards?.home,   homeMetric: 'cardsForAvg',     awayMetric: 'cardsForAvg' },
  away_cards:    { probObj: p => p?.perTeam?.away?.cards,   actualValue: a => a?.cards?.away,   homeMetric: 'cardsForAvg',     awayMetric: 'cardsForAvg' },
  home_shots:    { probObj: p => p?.perTeamShots?.home,     actualValue: a => a?.shots?.home,   homeMetric: 'shotsForAvg',     awayMetric: 'shotsAgainstAvg' },
  away_shots:    { probObj: p => p?.perTeamShots?.away,     actualValue: a => a?.shots?.away,   homeMetric: 'shotsAgainstAvg', awayMetric: 'shotsForAvg' },
  home_fouls:    { probObj: p => p?.perTeamFouls?.home,     actualValue: a => a?.fouls?.home,   homeMetric: 'foulsForAvg',     awayMetric: 'foulsForAvg' },
  away_fouls:    { probObj: p => p?.perTeamFouls?.away,     actualValue: a => a?.fouls?.away,   homeMetric: 'foulsForAvg',     awayMetric: 'foulsForAvg' },
};

function buildMarketDefs() {
  const defs = { ...SCALAR_DEFS };
  for (const [g, grp] of Object.entries(OU_GROUP_DEFS)) {
    for (let k = 0; k <= 20; k++) {
      const thr = k + 0.5;
      const over = `over${k}_5`, under = `under${k}_5`;
      defs[`${g}_${over}`] = {
        baseProb: p => grp.probObj(p)?.[over],
        outcome: a => { const v = grp.actualValue(a); return v != null && v > thr; },
        gate: a => grp.actualValue(a) != null,
        homeMetric: grp.homeMetric, awayMetric: grp.awayMetric,
      };
      defs[`${g}_${under}`] = {
        baseProb: p => grp.probObj(p)?.[under],
        outcome: a => { const v = grp.actualValue(a); return v != null && v < thr; },
        gate: a => grp.actualValue(a) != null,
        homeMetric: grp.homeMetric, awayMetric: grp.awayMetric,
      };
    }
  }
  return defs;
}

const MARKET_DEFS = buildMarketDefs();

// Lee la prob base (0-100 en predictions_full) → 0-1.
function baseProb01(def, predictionsFull) {
  const v = num(def.baseProb(predictionsFull));
  return v == null ? null : clamp(v / 100, 0.001, 0.999);
}

// Lee el shrunk_value + n de una métrica del perfil de equipo, en el SEGMENTO
// pedido (home/away) con fallback a 'all'. profileMap = { all:{m:{}}, home, away }.
function profileVal(profileMap, metric, segment) {
  const m = (profileMap?.[segment] && profileMap[segment][metric]) || profileMap?.all?.[metric];
  return { value: num(m?.shrunk_value), n: m?.sample_n || 0, consistency: num(m?.consistency) };
}

/**
 * Construye el vector de features para un mercado.
 * @returns {null | { base, features:{}, support:number, consistency:number, profileAvailable:boolean }}
 *   `base` = prob base 0-1 (para el baseline). `features` = slots numéricos
 *   (algunos null → el entrenador/ runtime imputan con la media).
 */
function buildMetaFeatures({ featuresFull, predictionsFull, homeProfile, awayProfile, market, h2h, causal }) {
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

  // El local usa su ADN COMO LOCAL; el visitante el suyo COMO VISITANTE.
  const hp = profileVal(homeProfile, def.homeMetric, 'home');
  const ap = profileVal(awayProfile, def.awayMetric, 'away');
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
    // ── Nivel 2 (H2H precomputado por el caller vía lib/h2h) ──
    h2h_rate:        (h2h && h2h.rate != null) ? h2h.rate : null,
    h2h_n:           Math.log1p(h2h?.n || 0),
    // blend EB: con n alto domina el H2H, con n bajo ≈ base. (k=3)
    h2h_blend:       (h2h && h2h.rate != null && h2h.n) ? ((h2h.n * h2h.rate + 3 * base) / (h2h.n + 3)) : null,
    // ── Nivel 3 (excepciones, precomputado por el caller) ──
    exception_rate:  causal?.exceptionRate != null ? causal.exceptionRate : null,
    rupture_today:   causal?.ruptureToday != null ? causal.ruptureToday : 0,
    today_rotation:  causal?.rotationRisk != null ? causal.rotationRisk : 0,
    today_congestion: (() => {
      const dh = stH.daysRest, da = stA.daysRest;
      const cong = (dh != null && dh <= 3) || (da != null && da <= 3);
      return cong ? 1 : 0;
    })(),
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
