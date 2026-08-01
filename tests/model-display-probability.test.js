const test = require('node:test');
const assert = require('node:assert/strict');

const { displayPct, modelToScored, playerMarketsToSelections } = require('../lib/model-to-scored.js');

test('94,x nunca se presenta como 95 y 95 real conserva el tope visual', () => {
  assert.equal(displayPct(94.96), 94.9);
  assert.equal(displayPct(94.5), 94.5);
  assert.equal(displayPct(95), 95);
  assert.equal(displayPct(99.9), 95);
  assert.equal(displayPct(0), 0);
});

test('los mercados de jugador respetan el mismo contrato visual', () => {
  const selections = playerMarketsToSelections({
    10: {
      player_id: 10,
      name: 'Jugador',
      markets: { anytime_scorer: { prob: 0.9496 } },
    },
  });
  assert.equal(selections[0].probability, 94.9);
});

test('la validación fuera de muestra bloquea la recomendación sin alterar la frecuencia', () => {
  const markets = {
    goals_total: {
      kind: 'ou',
      lines: [{ line: 0.5, prob: 0.95, n: 2, hits: 2, level: 'empirical' }],
    },
  };
  const scored = modelToScored(markets, {
    validationFamilies: {
      goals_total_over_0_5: { elite95: { n: 10, avg_pred: 0.95, avg_actual: 0.9 } },
      goals_total_under_0_5: { high: { n: 10, avg_pred: 0.1, avg_actual: 0.1 } },
    },
  });
  assert.equal(scored.total_goals_over0_5.prob_final, 0.95);
  assert.equal(scored.total_goals_over0_5.recommended, false);
  assert.equal(scored.total_goals_over0_5.validation.elite95Validated, false);
});

test('si la validación no está disponible, falla cerrado sin ocultar la frecuencia', () => {
  const scored = modelToScored({
    goals_total: {
      kind: 'ou',
      lines: [{ line: 0.5, prob: 0.98, n: 2, hits: 2, level: 'empirical' }],
    },
  });
  assert.equal(scored.total_goals_over0_5.prob_final, 0.98);
  assert.equal(scored.total_goals_over0_5.recommended, false);
  assert.equal(scored.total_goals_over0_5.validation.available, false);
  assert.equal(scored.total_goals_over0_5.validation.elite95Validated, false);
});

test('un 95% validado conserva recomendación sin imponer tamaño mínimo', () => {
  const markets = {
    corners_total: {
      kind: 'ou',
      lines: [{ line: 0.5, prob: 0.95, n: 1, hits: 1, level: 'empirical' }],
    },
  };
  const scored = modelToScored(markets, {
    validationFamilies: {
      corners_total_over_0_5: { elite95: { n: 1, avg_pred: 0.95, avg_actual: 1 } },
      corners_total_under_0_5: { high: { n: 1, avg_pred: 0.05, avg_actual: 0 } },
    },
  });
  assert.equal(scored.total_corners_over0_5.recommended, true);
  assert.equal(scored.total_corners_over0_5.validation.elite95Validated, true);
});

test('la apuesta diaria acepta 90% solo si esa frecuencia se sostuvo fuera de muestra', () => {
  const markets = {
    goals_total: {
      kind: 'ou',
      lines: [{ line: 1.5, prob: 0.9, n: 5, hits: 4.5, level: 'empirical' }],
    },
  };
  const passed = modelToScored(markets, {
    validationFamilies: {
      goals_total_over_1_5: { daily90: { n: 1, avg_pred: 0.9, avg_actual: 1 } },
      goals_total_under_1_5: { high: { n: 1, avg_pred: 0.1, avg_actual: 0 } },
    },
  });
  assert.equal(passed.total_goals_over1_5.prob_final, 0.9);
  assert.equal(passed.total_goals_over1_5.recommended, true);
  assert.equal(passed.total_goals_over1_5.validation.daily90Validated, true);

  const failed = modelToScored(markets, {
    validationFamilies: {
      goals_total_over_1_5: { daily90: { n: 10, avg_pred: 0.91, avg_actual: 0.8 } },
      goals_total_under_1_5: { high: { n: 10, avg_pred: 0.09, avg_actual: 0.2 } },
    },
  });
  assert.equal(failed.total_goals_over1_5.prob_final, 0.9);
  assert.equal(failed.total_goals_over1_5.recommended, false);
  assert.equal(failed.total_goals_over1_5.validation.daily90Validated, false);
});

test('una recomendación general debe sostener el porcentaje mostrado, no solo superar 80%', () => {
  const scored = modelToScored({
    goals_total: {
      kind: 'ou',
      lines: [{ line: 3.5, prob: 0.88, n: 20, hits: 18, level: 'empirical' }],
    },
  }, {
    validationFamilies: {
      goals_total_over_3_5: { high: { n: 10, avg_pred: 0.87, avg_actual: 0.8 } },
      goals_total_under_3_5: { high: { n: 10, avg_pred: 0.13, avg_actual: 0.2 } },
    },
  });
  assert.equal(scored.total_goals_over3_5.prob_final, 0.88);
  assert.equal(scored.total_goals_over3_5.recommended, false);
  assert.equal(scored.total_goals_over3_5.validation.target, 0.88);
});
