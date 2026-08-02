const test = require('node:test');
const assert = require('node:assert/strict');

const helperPromise = import('../apps/cfanalisis-worker/src/jobs/futbol/live-reconciliation.js');

test('un partido observado en vivo o final nunca regresa a no iniciado', async () => {
  const { shouldRejectStatusRegression } = await helperPromise;
  assert.equal(shouldRejectStatusRegression('2H', 'NS'), true);
  assert.equal(shouldRejectStatusRegression('LIVE', 'TBD'), true);
  assert.equal(shouldRejectStatusRegression('FT', 'NS'), true);
  assert.equal(shouldRejectStatusRegression('1H', '2H'), false);
  assert.equal(shouldRejectStatusRegression('NS', '1H'), false);
  assert.equal(shouldRejectStatusRegression('2H', 'FT'), false);
});

test('rescata un live ausente aunque liveStats ya haya sido contaminado con NS', async () => {
  const { collectStaleLiveFixtureIds } = await helperPromise;
  const ids = collectStaleLiveFixtureIds(
    { 10: { status: { short: 'NS' } }, 20: { status: { short: '2H' } } },
    [
      { fixture: { id: 10, status: { short: 'LIVE' } } },
      { fixture: { id: 30, status: { short: 'FT' } } },
    ],
    new Set(),
  );
  assert.deepEqual(ids.sort((a, b) => a - b), [10, 20]);
});

test('un estado cacheado solo se reconcilia por reloj; nunca se finaliza por reloj', async () => {
  const { cachedReconciliationKind } = await helperPromise;
  const now = 1_000_000;
  assert.equal(cachedReconciliationKind({ status: 'NS', kickoff: 1, expectedEnd: now - 11 * 60_000, now }), 'stale');
  assert.equal(cachedReconciliationKind({ status: '2H', kickoff: 1, expectedEnd: now - 11 * 60_000, now }), 'live');
  assert.equal(cachedReconciliationKind({ status: 'NS', kickoff: 1, expectedEnd: now + 60_000, now }), null);
  assert.equal(cachedReconciliationKind({ status: 'FT', kickoff: 1, expectedEnd: now + 60_000, now }), 'ft');
});
