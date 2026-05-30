/* eslint-disable */
// ─────────────────────────────────────────────────────────────────────────
// lib/baseball-ml.js — runtime de inferencia ML para baseball.
//
// Carga los modelos activos desde prediction_models (sport='baseball',
// active=TRUE) y aplica sus predicciones sobre el objeto `rawProbs` que
// genera lib/baseball-model.js (Poisson). El override solo se hace en los
// mercados con modelo activo; el resto queda intacto (fallback Poisson).
//
// MERCADOS soportados (deben coincidir con scripts/train-baseball-meta-models.js):
//   home_win                 → probabilities.moneyline.{home,away}
//   run_line_home_minus_15   → probabilities.runLine.{home_minus_1_5, away_plus_1_5}
//   total_over_85            → probabilities.totals.lines[8.5].{over,under}
//
// PARIDAD train↔runtime: predictWithModel hace la MISMA imputación (raw ==
// null → means[fn]) y la misma estandarización (z-score) que el train, leyendo
// model.{means, stds, coefs, bias, features} del weights JSON.
// ─────────────────────────────────────────────────────────────────────────

// Devuelve { home_win: weights, run_line_home_minus_15: weights, total_over_85: weights }.
// Solo los mercados con active=TRUE están en el resultado.
async function loadActiveBaseballModels(pgPool) {
  const { rows } = await pgPool.query(
    `SELECT market_key, weights
     FROM prediction_models
     WHERE sport='baseball' AND active=TRUE`
  );
  const out = {};
  for (const r of rows) {
    if (r.weights && r.market_key) out[r.market_key] = r.weights;
  }
  return out;
}

// MISMA fórmula que scripts/train-baseball-meta-models.js → paridad train↔runtime.
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

// Aplica las predicciones ML sobre `rawProbs` (formato de computeBaseball
// Probabilities en lib/baseball-model.js). Mutación in-place + retorno del
// mismo objeto. Devuelve también un metadata `mlApplied` para auditoría.
//
// rawProbs shape relevante:
//   { moneyline: { home, away },
//     runLine:   { home_minus_1_5, away_plus_1_5, ... },
//     totals:    { lines: { '8.5': { over, under }, ... }, bestLine }, ... }
function applyMlOverrides(rawProbs, models, features) {
  if (!rawProbs || !models || Object.keys(models).length === 0) {
    return { rawProbs, mlApplied: [] };
  }
  const applied = [];
  const round = (p01) => Math.round(Math.max(2, Math.min(98, p01 * 100)));

  // 1) home_win — moneyline.{home,away}
  if (models.home_win && rawProbs.moneyline) {
    const p = predictWithModel(models.home_win, features);
    if (p != null && isFinite(p)) {
      const h = round(p);
      rawProbs.moneyline.home = h;
      rawProbs.moneyline.away = 100 - h;
      applied.push({ market: 'home_win', p01: +p.toFixed(4), home: h });
    }
  }

  // 2) run_line_home_minus_15 — runLine.home_minus_1_5 + complemento away_plus_1_5
  if (models.run_line_home_minus_15 && rawProbs.runLine) {
    const p = predictWithModel(models.run_line_home_minus_15, features);
    if (p != null && isFinite(p)) {
      const h = round(p);
      rawProbs.runLine.home_minus_1_5 = h;
      rawProbs.runLine.away_plus_1_5  = 100 - h;
      applied.push({ market: 'run_line_home_minus_15', p01: +p.toFixed(4), home_minus_1_5: h });
    }
  }

  // 3) total_over_85 — totals.lines['8.5'].{over,under}.
  //    Si la línea 8.5 no existe en rawProbs (las líneas son adaptativas),
  //    inyectamos la entry para que la combinada pueda emitirla cuando hay
  //    cuota disponible. Mantenemos bestLine si ya estaba.
  if (models.total_over_85 && rawProbs.totals) {
    const p = predictWithModel(models.total_over_85, features);
    if (p != null && isFinite(p)) {
      const over = round(p);
      if (!rawProbs.totals.lines) rawProbs.totals.lines = {};
      rawProbs.totals.lines[8.5] = { over, under: 100 - over };
      applied.push({ market: 'total_over_85', p01: +p.toFixed(4), over });
    }
  }

  return { rawProbs, mlApplied: applied };
}

module.exports = {
  loadActiveBaseballModels,
  predictWithModel,
  applyMlOverrides,
};
