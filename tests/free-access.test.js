const test = require('node:test');
const assert = require('node:assert/strict');

test('Free returns one real 60–70% option; locked payloads contain only percentages', async () => {
  const { freeAnalysis } = await import('../lib/free-access.js');
  const source = { fixtureId: 4, homeTeam: 'A', awayTeam: 'B', secret: 'hidden-secret',
    calculatedProbabilities: { secret: 'hidden-statistics' }, finalVerdict: { pick: 'secret-verdict' },
    combinada: { selectable: [
      { id: 'free-low', name: 'Visible low', probability: 60, confidence: 95 },
      { id: 'free-high', name: 'Visible', probability: 70, confidence: 90 },
      { id: 'premium-secret', name: 'Premium secret name', probability: 89, confidence: 96, odd: 1.75, sampleN: 123 },
      { id: 'bad', name: 'Unreliable', probability: 67, confidence: 89.999 },
    ] } };
  const original = structuredClone(source);
  const result = freeAnalysis(source);
  assert.equal(result.freePreview.selection.name, 'Visible');
  assert.equal(result.freePreview.selection.probability, 70);
  assert.deepEqual(result.freePreview.locked, [{ probability: 89 }]);
  assert.doesNotMatch(JSON.stringify(result), /secret|free-low|Unreliable|sampleN|calculatedProbabilities|finalVerdict/);
  assert.deepEqual(source, original, 'paid source is not mutated');
});

test('Free never rounds an out of range pick into eligibility or invents one', async () => {
  const { freeAnalysis } = await import('../lib/free-access.js');
  for (const probability of [59.999, 70.001, NaN, null, 102]) {
    const result = freeAnalysis({ combinada: { selectable: [{ id: 'x', name: 'X', probability, confidence: 99 }] } });
    assert.equal(result.freePreview.selection, null);
    assert.ok(result.freePreview.unavailable);
  }
});

test('the same Free policy applies independently to all four sports', async () => {
  const { freeAnalysis } = await import('../lib/free-access.js');
  for (const sport of ['football', 'baseball', 'basketball', 'american_football']) {
    const result = freeAnalysis({ combinada: { selectable: [{ id: 'x', name: 'X', rawProbability: 65.123, reliability: 92 }] } }, sport);
    assert.equal(result.freePreview.selection.probability, 65.123);
    assert.deepEqual(Object.keys(result), ['access', 'freePreview']);
  }
});

test('separate football evidence preserves probability and paid confidence', async () => {
  const { freeFootballEvidence } = await import('../lib/free-football-evidence.js');
  const market = { goals_total: { kind: 'ou', lines: [{ line: 2.5, prob: .68, n: 1000, hits: 680, conf: .1, underConf: .1,
    chain: [{ step: 'empirical-weighted', n: 1000, hits: 680, currentShare: 1, current: { n: 1000, hits: 680 }, historical: { n: 0, hits: 0 } }] }] } };
  const original = structuredClone(market);
  const free = freeFootballEvidence(market);
  assert.equal(free.total_goals_over2_5.prob_final, .68);
  assert.ok(free.total_goals_over2_5.confidence >= .9);
  assert.deepEqual(market, original);
  assert.equal(free.total_goals_under2_5, undefined);
});

test('integer frequency grids count strict sides and use the observed range', async () => {
  const { displayFrequencyLadder } = await import('../lib/multisport-empirical-engine.js');
  const rows = [0, 10, 20, 130].map((value, i) => ({ fixture_id: i, _value: value, _weight: 1, _current: true, _side: 'home' }));
  const grid = displayFrequencyLadder(rows, .65, 10);
  assert.equal(Object.keys(grid)[0], '10');
  assert.equal(Object.keys(grid).at(-1), '130');
  assert.equal(grid[10].over.rawProbability, .5);
  assert.equal(grid[10].under.rawProbability, .25);
  assert.deepEqual(displayFrequencyLadder([], .65, 1), {});
});

test('locked percentages come from the actual Pro catalog, not 100% evidence extremes', async () => {
  const { freeAnalysis } = await import('../lib/free-access.js');
  for (const sport of ['football', 'baseball', 'basketball', 'american_football']) {
    const source = { _scored: { total_goals_over0_5: { prob_final: 1, confidence: 1 } },
      probabilities: { totals: { lines: { '0.5': { over: { rawProbability: 1, evidence: { n: 1000, hits: 1000 } } } } } },
      combinada: { selectable: [
        { id: 'free', name: 'Free', probability: 65, confidence: 95 },
        { id: 'pro-a', name: 'Secret A', probability: 84.5, confidence: 96 },
        { id: 'pro-b', name: 'Secret B', probability: 92.25, confidence: 96 },
      ] } };
    const original = structuredClone(source);
    assert.deepEqual(freeAnalysis(source, sport).freePreview.locked, [{ probability: 92.25 }, { probability: 84.5 }]);
    assert.deepEqual(freeAnalysis({ ...source, combinada: { selectable: [] } }, sport).freePreview.locked, []);
    assert.deepEqual(source, original);
  }
});
