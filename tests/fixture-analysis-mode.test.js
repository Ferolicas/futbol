const test = require('node:test');
const assert = require('node:assert/strict');
const { fixtureUsesHistoricalSnapshot } = require('../lib/fixture-analysis-mode.cjs');

function fixture(date, status = 'NS') {
  return { fixture: { date, status: { short: status } } };
}

const nowMs = Date.parse('2026-09-08T02:00:00Z');

test('toda jornada pasada conserva el snapshot aunque el kickoff sea futuro', () => {
  assert.equal(fixtureUsesHistoricalSnapshot(
    fixture('2026-09-09T20:00:00Z'),
    { isPastDate: true, nowMs },
  ), true);
});

test('un partido ya iniciado dentro de la jornada actual conserva el snapshot', () => {
  assert.equal(fixtureUsesHistoricalSnapshot(
    fixture('2026-09-08T01:00:00Z', '1H'),
    { isPastDate: false, nowMs },
  ), true);
});

test('un NS con kickoff vencido por zona horaria conserva el snapshot', () => {
  assert.equal(fixtureUsesHistoricalSnapshot(
    fixture('2026-09-07T23:30:00Z'),
    { isPastDate: false, nowMs },
  ), true);
});

test('un partido futuro de la jornada actual exige el contrato vigente', () => {
  assert.equal(fixtureUsesHistoricalSnapshot(
    fixture('2026-09-08T03:00:00Z'),
    { isPastDate: false, nowMs },
  ), false);
});
