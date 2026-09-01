const test = require('node:test');
const assert = require('node:assert/strict');

const { settleMarketSelection } = require('../lib/market-settlement.js');

const football = (status, home, away) => ({
  fixture: { status: { short: status } },
  goals: { home, away },
  score: { halftime: { home: 1, away: 0 }, fulltime: { home, away } },
});

test('un over se marca ganado en vivo apenas cruza la línea', () => {
  const outcome = settleMarketSelection({
    sport: 'football',
    game: football('2H', 2, 1),
    selection: { id: 'total_goals_over2_5' },
  });
  assert.equal(outcome.status, 'won');
});

test('un over que no cruza la línea no se marca perdido antes del final', () => {
  const outcome = settleMarketSelection({
    sport: 'football',
    game: football('2H', 1, 0),
    selection: { id: 'total_goals_over2_5' },
  });
  assert.equal(outcome.status, 'pending');
});

test('un over no alcanzado se marca perdido al cierre oficial', () => {
  const outcome = settleMarketSelection({
    sport: 'football',
    game: football('FT', 1, 0),
    selection: { id: 'total_goals_over2_5' },
  });
  assert.equal(outcome.status, 'lost');
});

test('una línea under se marca perdida en vivo cuando ya fue superada', () => {
  const outcome = settleMarketSelection({
    sport: 'football',
    game: football('2H', 2, 1),
    selection: { id: 'total_goals_under2_5' },
  });
  assert.equal(outcome.status, 'lost');
});

test('los contadores sin cobertura oficial quedan pendientes', () => {
  const outcome = settleMarketSelection({
    sport: 'football',
    game: football('FT', 1, 0),
    liveResult: { status: { short: 'FT' } },
    selection: { id: 'total_corners_over8_5' },
  });
  assert.equal(outcome.status, 'pending');
});

test('béisbol liquida total, run line y primeras cinco entradas', () => {
  const game = {
    status: { short: 'FT' },
    scores: { home: { total: 5 }, away: { total: 3 } },
    liveResult: {
      status: 'FT', inning: 9, home_score: 5, away_score: 3,
      innings: [
        { number: 1, home: 1, away: 0 }, { number: 2, home: 0, away: 1 },
        { number: 3, home: 2, away: 0 }, { number: 4, home: 0, away: 0 },
        { number: 5, home: 0, away: 0 },
      ],
    },
  };
  assert.equal(settleMarketSelection({ sport: 'baseball', game, selection: { id: 'total-7.5-over', line: 7.5, side: 'over' } }).status, 'won');
  assert.equal(settleMarketSelection({ sport: 'baseball', game, selection: { id: 'handicap-home-m1_5', line: -1.5, side: 'home' } }).status, 'won');
  assert.equal(settleMarketSelection({ sport: 'baseball', game, selection: { id: 'first5-total-4.5-over', line: 4.5, side: 'over' } }).status, 'lost');
});

test('basketball liquida por cuartos y fútbol americano por marcador final', () => {
  const basketball = {
    status: { short: 'FT' },
    scores: { home: { total: 108 }, away: { total: 101 } },
    periods: { home: [28, 25, 27, 28], away: [24, 26, 23, 28] },
  };
  assert.equal(settleMarketSelection({
    sport: 'basketball', game: basketball,
    selection: { id: 'quarter1-total-50.5-over', line: 50.5, side: 'over' },
  }).status, 'won');
  assert.equal(settleMarketSelection({
    sport: 'american-football',
    game: { status: { short: 'FT' }, scores: { home: { total: 28 }, away: { total: 17 } } },
    selection: { id: 'total-59.5-over', line: 59.5, side: 'over' },
  }).status, 'lost');
});
