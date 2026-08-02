const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPlayerCoverage,
  coveredPlayerCounter,
  nonNegativeInt,
  preferRelatedPayload,
} = require('../lib/model-ingest.js');

const entry = (minutes, overrides = {}) => ({
  st: {
    games: { minutes },
    goals: { total: null },
    shots: { total: null, on: null },
    fouls: { committed: null },
    cards: { yellow: 0, red: 0 },
    ...overrides,
  },
});

test('un jugador que jugó y no marcó entra como cero cuando el bloque reconcilia con el marcador', () => {
  const entries = [entry(90, { goals: { total: 1 } }), entry(90)];
  const coverage = buildPlayerCoverage(entries, {
    teamId: 10,
    teamGoals: 1,
    events: [],
    teamStats: [],
  });
  assert.equal(coverage.goals, true);
  assert.equal(coveredPlayerCounter(null, { covered: coverage.goals, minutes: 90 }), 0);
});

test('un gol en propia puerta no fabrica un goleador del equipo beneficiado', () => {
  const coverage = buildPlayerCoverage([entry(90), entry(90)], {
    teamId: 10,
    teamGoals: 1,
    events: [{ type: 'Goal', detail: 'Own Goal', team: { id: 10 } }],
    teamStats: [],
  });
  assert.equal(coverage.goals, true);
});

test('un campo de jugador totalmente ausente solo es cero si reconcilia con el total del equipo', () => {
  const entries = [entry(90), entry(45)];
  const unavailable = buildPlayerCoverage(entries, {
    teamId: 10,
    teamGoals: 0,
    teamStats: [{ team: { id: 10 }, statistics: [{ type: 'Total Shots', value: 8 }] }],
  });
  assert.equal(unavailable.shots_total, false);
  assert.equal(coveredPlayerCounter(null, { covered: unavailable.shots_total, minutes: 90 }), null);

  const realZero = buildPlayerCoverage(entries, {
    teamId: 10,
    teamGoals: 0,
    teamStats: [{ team: { id: 10 }, statistics: [{ type: 'Total Shots', value: 0 }] }],
  });
  assert.equal(realZero.shots_total, true);
  assert.equal(coveredPlayerCounter(null, { covered: realZero.shots_total, minutes: 90 }), 0);
});

test('un contador imposible negativo del proveedor queda desconocido', () => {
  assert.equal(nonNegativeInt(-18), null);
  assert.equal(nonNegativeInt('-40'), null);
  assert.equal(nonNegativeInt(0), 0);
  assert.equal(nonNegativeInt('90'), 90);
});

test('la ingesta postpartido usa statistics embebidas si el crudo relacionado está vacío', () => {
  const embedded = [{ team: { id: 1 }, statistics: [{ type: 'Corner Kicks', value: 4 }] }];
  assert.equal(preferRelatedPayload({ response: [] }, embedded), embedded);
});

test('la ingesta postpartido conserva el crudo relacionado cuando ya tiene datos', () => {
  const raw = { response: [{ team: { id: 1 }, statistics: [] }] };
  const embedded = [{ team: { id: 2 }, statistics: [] }];
  assert.equal(preferRelatedPayload(raw, embedded), raw);
});
