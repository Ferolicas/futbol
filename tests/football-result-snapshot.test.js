const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractResultCoverage,
  buildMatchResultRow,
  buildDurableResultSnapshot,
  mergeDurableResultWithLive,
  mergeFixtureWithDurableResult,
} = require('../lib/football-result-snapshot.cjs');

function fixture(overrides = {}) {
  return {
    fixture: { id: 101, date: '2026-08-02T01:00:00Z', status: { short: 'FT', long: 'Match Finished', elapsed: 90 } },
    league: { id: 39, name: 'Test League' },
    teams: {
      home: { id: 10, name: 'Local', logo: 'home.png' },
      away: { id: 20, name: 'Visitante', logo: 'away.png' },
    },
    goals: { home: 2, away: 1 },
    score: { halftime: { home: 1, away: 0 }, fulltime: { home: 2, away: 1 } },
    events: [],
    statistics: [],
    ...overrides,
  };
}

test('un resultado de cobertura limitada conserva goles sin fabricar otros mercados', () => {
  const match = fixture();
  const coverage = extractResultCoverage(match);
  assert.deepEqual(coverage.corners, { home: null, away: null, total: null });
  assert.deepEqual(coverage.yellowCards, { home: null, away: null, total: null });

  const row = buildMatchResultRow('2026-08-02', match);
  assert.deepEqual(row.goals, { home: 2, away: 1 });
  assert.equal(row.corners.total, null);

  const snapshot = buildDurableResultSnapshot({ ...row, created_at: '2026-08-02T03:00:00Z' });
  assert.equal(snapshot.realFinal, true);
  assert.deepEqual(snapshot.goals, { home: 2, away: 1 });
  assert.equal(snapshot.corners, undefined);
  assert.equal(snapshot.yellowCards, undefined);
});

test('si hay eventos de tarjetas se conserva ese mercado aunque no haya statistics', () => {
  const match = fixture({
    events: [{
      type: 'Card', detail: 'Yellow Card', time: { elapsed: 34 },
      team: { id: 10, name: 'Local' }, player: { id: 7, name: 'Defensa' },
    }],
  });
  const coverage = extractResultCoverage(match);
  assert.deepEqual(coverage.yellowCards, { home: 1, away: 0, total: 1 });
  assert.deepEqual(coverage.redCards, { home: 0, away: 0, total: 0 });
  assert.equal(coverage.cardEvents.length, 1);

  const snapshot = buildDurableResultSnapshot(buildMatchResultRow('2026-08-02', match));
  assert.deepEqual(snapshot.yellowCards, { home: 1, away: 0, total: 1, isReal: true });
  assert.deepEqual(snapshot.redCards, { home: 0, away: 0, total: 0, isReal: true });
});

test('un cero con bloques estadísticos de ambos equipos es un cero real', () => {
  const match = fixture({
    statistics: [
      { team: { id: 10 }, statistics: [{ type: 'Corner Kicks', value: 0 }, { type: 'Ball Possession', value: '51%' }] },
      { team: { id: 20 }, statistics: [{ type: 'Corner Kicks', value: 0 }, { type: 'Ball Possession', value: '49%' }] },
    ],
  });
  const snapshot = buildDurableResultSnapshot(buildMatchResultRow('2026-08-02', match));
  assert.deepEqual(snapshot.corners, { home: 0, away: 0, total: 0, isReal: true });
  assert.deepEqual(snapshot.yellowCards, { home: 0, away: 0, total: 0, isReal: true });
  assert.deepEqual(snapshot.redCards, { home: 0, away: 0, total: 0, isReal: true });
});

test('los valores parciales se guardan pero no se publican como un total falso', () => {
  const match = fixture({
    statistics: [
      { team: { id: 10 }, statistics: [{ type: 'Corner Kicks', value: 3 }] },
    ],
  });
  const row = buildMatchResultRow('2026-08-02', match);
  assert.deepEqual(row.corners, { home: 3, away: null, total: null });
  assert.equal(buildDurableResultSnapshot(row).corners, undefined);
});

test('PostgreSQL final gana sobre Redis NS sin perder estadísticas reales', () => {
  const result = buildDurableResultSnapshot(buildMatchResultRow('2026-08-02', fixture({
    statistics: [
      { team: { id: 10 }, statistics: [{ type: 'Corner Kicks', value: 4 }] },
      { team: { id: 20 }, statistics: [{ type: 'Corner Kicks', value: 2 }] },
    ],
  })));
  const stale = { status: { short: 'NS' }, goals: { home: null, away: null }, corners: { home: 0, away: 0, total: 0, isReal: false } };
  const merged = mergeDurableResultWithLive(result, stale);
  assert.equal(merged.status.short, 'FT');
  assert.deepEqual(merged.goals, { home: 2, away: 1 });
  assert.deepEqual(merged.corners, { home: 4, away: 2, total: 6, isReal: true });

  const fixtureCard = mergeFixtureWithDurableResult(fixture({
    fixture: { id: 101, date: '2026-08-02T01:00:00Z', status: { short: 'NS' } },
    goals: { home: null, away: null },
  }), result);
  assert.equal(fixtureCard.fixture.status.short, 'FT');
  assert.deepEqual(fixtureCard.goals, { home: 2, away: 1 });
});
