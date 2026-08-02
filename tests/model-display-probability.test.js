const test = require('node:test');
const assert = require('node:assert/strict');

const { displayPct, modelToScored, playerMarketsToSelections } = require('../lib/model-to-scored.js');
const { calculateGoalTimingProbabilities } = require('../lib/descriptive-stats.js');

let buildModelCombinada;
test.before(async () => {
  ({ buildModelCombinada } = await import('../lib/model-probabilities.js'));
});

test('la presentación limita a 95% sin alterar la frecuencia del motor', () => {
  assert.equal(displayPct(0), 0);
  assert.equal(displayPct(4.25), 4.25);
  assert.equal(displayPct(94.96), 94.96);
  assert.equal(displayPct(94.999), 94.99);
  assert.equal(displayPct(95), 95);
  assert.equal(displayPct(99.9), 95);
  assert.equal(displayPct(100), 95);
});

test('los mercados de jugador respetan el mismo contrato exacto', () => {
  const selections = playerMarketsToSelections({
    10: {
      player_id: 10,
      name: 'Jugador',
      markets: { anytime_scorer: { prob: 0.9496 } },
    },
  });
  assert.equal(selections[0].probability, 94.96);
  assert.equal(selections[0].rawProbability, 94.96);
});

test('la validación fuera de muestra queda como diagnóstico y no altera ni bloquea', () => {
  const scored = modelToScored({
    goals_total: {
      kind: 'ou',
      lines: [{ line: 0.5, prob: 0.95, n: 2, hits: 2, level: 'empirical' }],
    },
  }, {
    validationFamilies: {
      goals_total_over_0_5: { elite95: { n: 10, avg_pred: 0.95, avg_actual: 0.9, gap: 0.05 } },
    },
  });
  const result = scored.total_goals_over0_5;
  assert.equal(result.prob_final, 0.95);
  assert.equal(result.recommended, true);
  assert.deepEqual(result.validation, {
    available: true,
    family: 'goals_total_over_0_5',
    band: 'elite95',
    n: 10,
    avgPred: 0.95,
    avgActual: 0.9,
    gap: 0.05,
  });
});

test('la falta de diagnóstico nunca oculta una frecuencia calculada', () => {
  const scored = modelToScored({
    goals_total: {
      kind: 'ou',
      lines: [{ line: 0.5, prob: 0.98, n: 2, hits: 2, level: 'empirical' }],
    },
  });
  assert.equal(scored.total_goals_over0_5.prob_final, 0.98);
  assert.equal(scored.total_goals_over0_5.recommended, true);
  assert.deepEqual(scored.total_goals_over0_5.validation, {
    available: false,
    family: 'goals_total_over_0_5',
  });
});

test('una sola observación puede producir 100% interno y mostrar 95%', () => {
  const scored = modelToScored({
    corners_total: {
      kind: 'ou',
      lines: [{ line: 0.5, prob: 1, n: 1, hits: 1, level: 'empirical' }],
    },
  });
  assert.equal(scored.total_corners_over0_5.prob_final, 1);
  assert.equal(displayPct(scored.total_corners_over0_5.prob_final * 100), 95);
  assert.equal(scored.total_corners_over0_5.recommended, true);
});

test('la combinada calcula con el valor crudo aunque visualmente muestre 95%', () => {
  const scored = modelToScored({
    goals_total: {
      kind: 'ou',
      lines: [{ line: 0.5, prob: 0.9975, n: 4, hits: 4, level: 'empirical' }],
    },
  });
  const result = buildModelCombinada(
    scored,
    { overUnder: { Over_0_5: 1.5 } },
    { home: 'Local', away: 'Visitante' },
    {},
    {},
    null,
  );
  assert.equal(result.selections[0].probability, 95);
  assert.equal(result.selections[0].rawProbability, 99.75);
  assert.equal(result.combinedProbability, 99.75);
});

test('80% es el único umbral de producto para una recomendación general', () => {
  const scored = modelToScored({
    goals_total: {
      kind: 'ou',
      lines: [
        { line: 1.5, prob: 0.8, n: 5, hits: 4, level: 'empirical' },
        { line: 2.5, prob: 0.7999, n: 5, hits: 4, level: 'empirical' },
      ],
    },
  });
  assert.equal(scored.total_goals_over1_5.recommended, true);
  assert.equal(scored.total_goals_over2_5.recommended, false);
});

test('la combinada y la Apuesta del Día usan la frecuencia, no el diagnóstico', () => {
  const scored = modelToScored({
    goals_total: {
      kind: 'ou',
      lines: [{ line: 1.5, prob: 0.9, n: 5, hits: 4, level: 'empirical' }],
    },
  }, {
    validationFamilies: {
      goals_total_over_1_5: { daily90: { n: 20, avg_pred: 0.9, avg_actual: 0.7 } },
    },
  });
  const result = buildModelCombinada(
    scored,
    { overUnder: { Over_1_5: 1.6 } },
    { home: 'Local', away: 'Visitante' },
    {},
    {},
    null,
  );
  assert.equal(result.selections.length, 1);
  assert.equal(result.selections[0].probability, 90);
  assert.equal(result.selections[0].rawProbability, 90);
  assert.equal(result.selections[0].dailyEligible, true);
});

test('un prop de jugador con frecuencia real y cuota entra sin gate adicional', () => {
  const result = buildModelCombinada(
    {},
    {
      allBookmakerOdds: [{
        name: 'bet365',
        players: { scorer: { jugador: 1.65 } },
      }],
    },
    { home: 'Local', away: 'Visitante' },
    {
      10: {
        player_id: 10,
        name: 'Jugador',
        markets: { anytime_scorer: { prob: 0.9 } },
      },
    },
    {},
    null,
  );
  assert.equal(result.selections.length, 1);
  assert.equal(result.selections[0].scope, 'player');
  assert.equal(result.selections[0].probability, 90);
  assert.equal(result.selections[0].dailyEligible, true);
});

test('los tramos de gol cuentan partidos con ocurrencia y no cantidad de goles', () => {
  const timing = calculateGoalTimingProbabilities({
    home: {
      totalMatches: 2,
      periods: { '0-15': { scored: 3, conceded: 0, matchesWithGoal: 1 } },
    },
    away: {
      totalMatches: 2,
      periods: { '0-15': { scored: 1, conceded: 1, matchesWithGoal: 2 } },
    },
  });
  assert.equal(timing.home[0].probability, 50);
  assert.equal(timing.away[0].probability, 100);
  assert.equal(timing.combined[0].probability, 75);
});
