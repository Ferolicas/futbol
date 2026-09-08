const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeDistribution,
  distributionTotal,
  strictPregameCutoff,
  deVigProbabilities,
  offeredExpectedValue,
  assessValidation,
  calibrateProbability,
  recommendationDecision,
} = require('../lib/prediction-math.cjs');

test('normaliza una distribución y conserva exactamente toda la masa', () => {
  const distribution = normalizeDistribution({ home: 2, draw: 1, away: 1 });
  assert.equal(distribution.home, 0.5);
  assert.equal(distribution.draw, 0.25);
  assert.ok(Math.abs(distributionTotal(distribution) - 1) < 1e-12);
});

test('rechaza distribuciones inválidas en vez de ocultarlas', () => {
  assert.throws(() => normalizeDistribution([0.5, -0.1, 0.6]), /invalid/);
  assert.throws(() => normalizeDistribution([0, 0]), /zero_mass/);
});

test('el corte prepartido nunca alcanza el kickoff aunque se recalcule después', () => {
  const kickoff = new Date('2026-09-08T18:00:00.000Z');
  assert.equal(strictPregameCutoff(kickoff, new Date('2026-09-08T17:00:00.000Z')).toISOString(), '2026-09-08T17:00:00.000Z');
  assert.equal(strictPregameCutoff(kickoff, new Date('2026-09-08T20:00:00.000Z')).toISOString(), '2026-09-08T17:59:59.999Z');
});

test('de-vig retira el overround sin alterar el orden', () => {
  const fair = deVigProbabilities({ home: 1.8, away: 2.1 });
  assert.ok(fair.home > fair.away);
  assert.ok(Math.abs(distributionTotal(fair) - 1) < 1e-12);
});

test('EV usa cuota ofrecida, probabilidad de victoria y push', () => {
  assert.ok(Math.abs(offeredExpectedValue(0.7, 1.2) - (-0.16)) < 1e-12);
  assert.ok(Math.abs(offeredExpectedValue(0.55, 2.1) - 0.155) < 1e-12);
  assert.ok(Math.abs(offeredExpectedValue(0.5, 2, 0.1) - 0.1) < 1e-12);
});

test('una familia muy descalibrada queda bloqueada', () => {
  const result = assessValidation({ available: true, n: 100, avgPred: 0.94, avgActual: 0.55 });
  assert.equal(result.eligible, false);
  assert.equal(result.status, 'miscalibrated');
});

test('la calibración corrige gradualmente y nunca sale de 0..1', () => {
  const adjusted = calibrateProbability(0.9, { available: true, n: 100, avgPred: 0.9, avgActual: 0.7 });
  assert.equal(adjusted, 0.8);
  assert.ok(Math.abs(calibrateProbability(1, { available: true, n: 1000, avgPred: 1, avgActual: 0 }) - (1 / 11)) < 1e-12);
});

test('una recomendación exige validación y EV, no solo porcentaje', () => {
  const validation = { available: true, n: 500, avgPred: 0.72, avgActual: 0.70 };
  assert.equal(recommendationDecision({ probability: 0.7, odd: 1.2, reliability: 99, validation }).eligible, false);
  const accepted = recommendationDecision({ probability: 0.7, odd: 1.55, reliability: 99, validation });
  assert.equal(accepted.eligible, true);
  assert.ok(accepted.expectedValue >= 0.05);
});
