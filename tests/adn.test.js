const test = require('node:test');
const assert = require('node:assert/strict');
const { buildActuals, recordFromRaw } = require('../lib/adn.js');

test('cobertura parcial no convierte tiros, córners ni faltas ausentes en cero', () => {
  const fixture = {
    fixture: { id: 1, date: '2026-01-01T12:00:00Z', status: { short: 'FT' } },
    league: { id: 39, round: 'Regular Season - 1' },
    teams: { home: { id: 10 }, away: { id: 20 } },
    goals: { home: 1, away: 0 },
    score: { fulltime: { home: 1, away: 0 }, halftime: { home: 0, away: 0 } },
  };
  const stats = { response: [
    { team: { id: 10 }, statistics: [{ type: 'Ball Possession', value: '52%' }] },
    { team: { id: 20 }, statistics: [{ type: 'Ball Possession', value: '48%' }] },
  ] };
  const actual = buildActuals(fixture, stats, { response: [] }, null);
  assert.equal(actual.shots.home, null);
  assert.equal(actual.shots.onTargetHome, null);
  assert.equal(actual.corners.home, null);
  assert.equal(actual.fouls.home, null);
  assert.equal(actual.cards.home, 0);
  assert.equal(actual.offsides.home, 0);
});

test('un bloque estadístico ausente no se interpreta como cero tarjetas', () => {
  const fixture = {
    fixture: { id: 2, date: '2026-01-01T12:00:00Z', status: { short: 'FT' } },
    league: { id: 39 }, teams: { home: { id: 10 }, away: { id: 20 } },
    goals: { home: 0, away: 0 }, score: { fulltime: { home: 0, away: 0 } },
  };
  const stats = { response: [
    { team: { id: 10 }, statistics: [{ type: 'Yellow Cards', value: 1 }] },
  ] };
  const actual = buildActuals(fixture, stats, { response: [] }, null);
  assert.equal(actual.cards.home, 1);
  assert.equal(actual.cards.away, null);
  assert.equal(actual.cards.total, null);
});

test('el registro por equipo tampoco fabrica cero tarjetas sin bloque estadístico', () => {
  const fixture = {
    fixture: { id: 3, date: '2026-01-01T12:00:00Z', status: { short: 'FT' } },
    league: { id: 39 }, teams: { home: { id: 10 }, away: { id: 20 } },
    goals: { home: 0, away: 0 }, score: { fulltime: { home: 0, away: 0 } },
  };
  const stats = { response: [
    { team: { id: 10 }, statistics: [{ type: 'Ball Possession', value: '50%' }] },
  ] };
  assert.equal(recordFromRaw(fixture, stats, 10).cards, 0);
  assert.equal(recordFromRaw(fixture, stats, 20).cards, null);
});
