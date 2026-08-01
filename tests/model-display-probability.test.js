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
