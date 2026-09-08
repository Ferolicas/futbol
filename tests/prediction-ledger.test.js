const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:1/cfanalisis_test';
process.env.DATABASE_SSL ||= 'false';

test('el hash de un pronóstico es reproducible aunque cambie el orden de las claves', async () => {
  const { predictionPayloadHash } = await import('../lib/prediction-ledger.js');
  const left = { fixture: 7, nested: { b: 2, a: 1 }, values: [{ z: true, a: false }] };
  const right = { values: [{ a: false, z: true }], nested: { a: 1, b: 2 }, fixture: 7 };
  assert.equal(predictionPayloadHash(left), predictionPayloadHash(right));
});

test('la calibración del ledger separa familia, horizonte y bandas', async () => {
  const { predictionLedgerInternals } = await import('../lib/prediction-ledger.js');
  const rows = [
    { horizon: 'early', market_family: 'total_goals_over2_5', probability_raw: 0.80, outcome: 'won' },
    { horizon: 'early', market_family: 'total_goals_over2_5', probability_raw: 0.90, outcome: 'lost' },
    { horizon: 'confirmed-lineup', market_family: 'total_goals_over2_5', probability_raw: 0.95, outcome: 'won' },
    { horizon: 'early', market_family: 'ignored_push', probability_raw: 0.90, outcome: 'push' },
  ];
  const groups = predictionLedgerInternals.aggregateLedgerCalibration(rows);
  const early = groups.find((row) => row.horizon === 'early' && row.family === 'total_goals_over2_5');
  const confirmed = groups.find((row) => row.horizon === 'confirmed-lineup');
  assert.equal(early.n, 2);
  assert.ok(Math.abs(early.avg_pred - 0.85) < 1e-12);
  assert.equal(early.avg_actual, 0.5);
  assert.equal(early.selectable70.n, 2);
  assert.equal(early.high.n, 2);
  assert.equal(early.daily90.n, 1);
  assert.equal(confirmed.elite95.n, 1);
  assert.equal(groups.some((row) => row.family === 'ignored_push'), false);
});

test('el ledger valida la probabilidad publicada, no vuelve a puntuar la cruda', async () => {
  const { predictionLedgerInternals } = await import('../lib/prediction-ledger.js');
  const [group] = predictionLedgerInternals.aggregateLedgerCalibration([{
    horizon: 'early', market_family: 'goals',
    probability_raw: 0.95, probability_calibrated: 0.74, outcome: 'won',
  }]);
  assert.equal(group.avg_pred, 0.74);
  assert.equal(group.selectable70.n, 1);
  assert.equal(group.high.n, 0);
});

test('una muestra corta nunca reemplaza una calibración madura', async () => {
  const { predictionLedgerInternals } = await import('../lib/prediction-ledger.js');
  const mature = { goals: { n: 300, avg_pred: 0.8, avg_actual: 0.79 } };
  const incoming = {
    goals: { n: 12, avg_pred: 0.9, avg_actual: 0.4 },
    corners: { n: 40, avg_pred: 0.75, avg_actual: 0.73 },
  };
  assert.deepEqual(predictionLedgerInternals.mergeEligible(mature, incoming, 30), {
    goals: mature.goals,
    corners: incoming.corners,
  });
});
