const test = require('node:test');
const assert = require('node:assert/strict');

test('Free returns one real 60–70% option; locked payloads contain only percentages', async () => {
  const { freeAnalysis } = await import('../lib/free-access.js');
  const source = { fixtureId: 4, homeTeam: 'A', awayTeam: 'B', secret: 'hidden-secret',
    calculatedProbabilities: { secret: 'hidden-statistics' }, finalVerdict: { pick: 'secret-verdict' },
    combinada: { selectable: [
      { id: 'free-low', name: 'Visible low', probability: 60, confidence: 95, odd: 1.7, bookmaker: 'Bet365' },
      { id: 'free-high', name: 'Visible', probability: 70, confidence: 90, odd: 1.6, bookmaker: 'Bwin' },
      { id: 'premium-secret', name: 'Premium secret name', probability: 89, confidence: 96, odd: 1.75, bookmaker: 'Bet365', sampleN: 123 },
      { id: 'bad', name: 'Unreliable', probability: 67, confidence: 4, odd: 1.8, bookmaker: 'Bet365' },
    ] } };
  const original = structuredClone(source);
  const result = freeAnalysis(source);
  assert.equal(result.freePreview.selection.id, 'free-high');
  assert.equal(result.freePreview.selection.name, 'Visible');
  assert.equal(result.freePreview.selection.probability, 70);
  assert.equal(result.freePreview.selection.odd, 1.6);
  assert.equal(result.freePreview.selection.bookmaker, 'Bwin');
  assert.equal(result.freePreview.selection.reliability, undefined);
  assert.deepEqual(result.freePreview.locked, [{ probability: 89 }]);
  assert.doesNotMatch(JSON.stringify(result), /secret|free-low|Unreliable|sampleN|calculatedProbabilities|finalVerdict/);
  assert.deepEqual(source, original, 'paid source is not mutated');
});

test('Free never rounds an out of range pick into eligibility or invents one', async () => {
  const { freeAnalysis } = await import('../lib/free-access.js');
  for (const probability of [59.999, 70.001, NaN, null, 102]) {
    const result = freeAnalysis({ combinada: { selectable: [{ id: 'x', name: 'X', probability, confidence: 99, odd: 1.5, bookmaker: 'Bet365' }] } });
    assert.equal(result.freePreview.selection, null);
    assert.ok(result.freePreview.unavailable);
  }
});

test('the same Free policy applies independently to all four sports', async () => {
  const { freeAnalysis } = await import('../lib/free-access.js');
  for (const sport of ['football', 'baseball', 'basketball', 'american_football']) {
    const result = freeAnalysis({ combinada: { selectable: [{ id: 'x', name: 'X', rawProbability: 65.123, reliability: 2, odd: 1.5, bookmaker: 'Bet365' }] } }, sport);
    assert.equal(result.freePreview.selection.probability, 65.123);
    assert.deepEqual(Object.keys(result), ['access', 'freePreview']);
  }
});

test('separate football evidence keeps 60–70% options even with low reliability', async () => {
  const { freeFootballEvidence } = await import('../lib/free-football-evidence.js');
  const market = { goals_total: { kind: 'ou', lines: [{ line: 2.5, prob: .68, n: 5, hits: 4, conf: .1, underConf: .1,
    chain: [{ step: 'empirical-weighted', n: 5, hits: 4, currentShare: 1, current: { n: 5, hits: 4 }, historical: { n: 0, hits: 0 } }] }] } };
  const original = structuredClone(market);
  const free = freeFootballEvidence(market);
  assert.equal(free.total_goals_over2_5.prob_final, .68);
  assert.ok(free.total_goals_over2_5.confidence < .9);
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
        { id: 'pro-a', name: 'Secret A', probability: 84.5, confidence: 96, odd: 1.4, bookmaker: 'Bet365' },
        { id: 'pro-b', name: 'Secret B', probability: 92.25, confidence: 96, odd: 1.5, bookmaker: 'Bwin' },
      ] } };
    const original = structuredClone(source);
    assert.deepEqual(freeAnalysis(source, sport).freePreview.locked, [{ probability: 92.25 }, { probability: 84.5 }]);
    assert.deepEqual(freeAnalysis({ ...source, combinada: { selectable: [] } }, sport).freePreview.locked, []);
    assert.deepEqual(source, original);
  }
});

test('Free requires a named real bookmaker price and ignores reliability', async () => {
  const { freeAnalysis } = await import('../lib/free-access.js');
  const result = freeAnalysis({ combinada: { selectable: [
    { id: 'no-odd', name: 'No odd', probability: 69, confidence: 100, bookmaker: 'Bet365' },
    { id: 'generic', name: 'Generic', probability: 68, confidence: 100, odd: 1.5, bookmaker: 'bet365 / bwin' },
    { id: 'implied', name: 'Estimated', probability: 68, odd: 1.5, bookmaker: 'Bet365', impliedOdds: true },
    { id: 'low-reliability', name: 'Visible', probability: 67, confidence: 1, odd: 1.62, bookmaker: 'Bet365' },
  ] } });
  assert.equal(result.freePreview.selection.name, 'Visible');
  assert.equal(result.freePreview.selection.odd, 1.62);
  assert.equal(result.freePreview.selection.reliability, undefined);
});

test('hidden options reveal with win/loss only after the official final', async () => {
  const { freeAnalysis } = await import('../lib/free-access.js');
  const source = { homeTeam: 'A', awayTeam: 'B', combinada: { selectable: [
    { id: 'free', name: 'Gratis', probability: 65, odd: 1.5, bookmaker: 'Bet365' },
    { id: 'total_goals_over2_5', scope: 'context', name: 'SECRET OVER', probability: 82, odd: 1.4, bookmaker: 'Bet365' },
    { id: 'total_goals_under2_5', scope: 'context', name: 'SECRET UNDER', probability: 79, odd: 1.6, bookmaker: 'Bwin' },
  ] } };
  const live = { fixture: { status: { short: 'LIVE' } }, teams: { home: { name: 'A' }, away: { name: 'B' } }, goals: { home: 2, away: 1 } };
  const before = freeAnalysis(source, 'football', { game: live });
  assert.equal(before.freePreview.revealed.length, 0);
  assert.doesNotMatch(JSON.stringify(before), /SECRET|Más de|Menos de/);
  const final = { ...live, fixture: { status: { short: 'FT' } } };
  const after = freeAnalysis(source, 'football', { game: final });
  assert.deepEqual(after.freePreview.locked, []);
  assert.deepEqual(after.freePreview.revealed.map(item => item.outcome.status), ['won', 'lost']);
  assert.ok(after.freePreview.revealed.every(item => item.odd >= 1.2 && item.bookmaker));
});
