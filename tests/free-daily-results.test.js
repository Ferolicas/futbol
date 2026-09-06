const test = require('node:test');
const assert = require('node:assert/strict');

for (const sport of ['football', 'baseball', 'basketball', 'american_football']) {
  test(`${sport}: Free publishes only final daily picks, including wins and losses without analysis evidence`, async () => {
    const { freeDailyResults } = await import('../lib/free-daily-results.js');
    const football = sport === 'football';
    const fixtures = ['NS', 'LIVE', 'FT', 'FT', 'PST'].map((status, i) => {
      const id = i + 1;
      const selection = { id: football ? 'total_goals_over2_5' : 'total-2.5-over',
        name: `Original pick ${id}`, probability: 81.36, rawProbability: 81.369,
        odd: 1.4, confidence: 94, reliability: 94, bookmaker: 'Bet365', line: 2.5, side: 'over',
        sampleN: 300, evidence: 'SECRET-EVIDENCE', analysis: 'SECRET-ANALYSIS' };
      return { id, fixture: { id, date: '2020-01-01', status: { short: status } }, status: { short: status },
        teams: { home: { name: 'Home' }, away: { name: 'Away' } },
        goals: { home: id === 4 ? 0 : 3, away: 0 },
        scores: { home: { total: id === 4 ? 0 : 3 }, away: { total: 0 } },
        analysis: { combinada: { source: 'context-engine', selectable: [selection] } },
      };
    });
    const source = { sport, fixtures, analyzedData: Object.fromEntries(fixtures.map(g => [g.id, g.analysis])) };
    const original = structuredClone(source);
    const results = freeDailyResults(source);
    assert.deepEqual(results.map(r => r.fixtureId), [3, 4]);
    assert.deepEqual(results.map(r => r.outcome.status), ['won', 'lost']);
    assert.ok(results.every(r => r.resultState.isFinal && !r.resultState.isLive));
    assert.ok(results.every(r => r.rawProbability === 81.369));
    assert.doesNotMatch(JSON.stringify(results), /Original pick [125]|SECRET|sampleN|evidence|combinada/);
    assert.deepEqual(source, original, 'Pro source remains intact');
    assert.deepEqual(freeDailyResults({ ...source, fixtures: fixtures.filter(g => g.id < 3) }), []);
  });
}

test('only the original qualifying daily catalog is exposed after official closure', async () => {
  const { freeDailyResults } = await import('../lib/free-daily-results.js');
  const game = { fixture: { id: 9, status: { short: 'FT' } }, teams: { home: { name: 'A' }, away: { name: 'B' } } };
  const selected = { id: 'total_corners_over8_5', name: 'Córners', probability: 89, confidence: 94, odd: 1.3 };
  const source = { sport: 'football', fixtures: [game], analyzedData: { 9: { combinada: { source: 'context-engine', selectable: [
    selected, { ...selected, name: 'Low reliability', confidence: 89 },
    { ...selected, name: 'Low probability', probability: 74 }, { ...selected, name: 'Low odds', odd: 1.1 },
  ] } } } };
  const results = freeDailyResults(source);
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Córners');
  assert.equal(results[0].outcome.status, 'pending', 'missing official counters never become a win');
});
