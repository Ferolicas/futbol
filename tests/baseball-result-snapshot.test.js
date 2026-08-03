const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractMlbTeamResultStats,
  buildBaseballResultRow,
  baseballResultRowChanged,
} = require('../lib/baseball-result-snapshot.js');

const boxscore = {
  teams: {
    home: { teamStats: { batting: {
      hits: 9, homeRuns: 0, doubles: 2, triples: 0, strikeOuts: 6,
      baseOnBalls: 3, stolenBases: 0, leftOnBase: 16, totalBases: 11,
      rbi: 4, atBats: 35,
    }, fielding: { errors: 1 } } },
    away: { teamStats: { batting: {
      hits: 9, homeRuns: 4, doubles: 0, triples: 0, strikeOuts: 11,
      baseOnBalls: 5, stolenBases: 0, leftOnBase: 17, totalBases: 21,
      rbi: 6, atBats: 36,
    }, fielding: { errors: 0 } } },
  },
};

test('el boxscore oficial conserva ceros reales y estadísticas de bateo', () => {
  const home = extractMlbTeamResultStats(boxscore, 'home');
  const away = extractMlbTeamResultStats(boxscore, 'away');
  assert.equal(home.homeRuns, 0);
  assert.equal(home.errors, 1);
  assert.equal(away.homeRuns, 4);
  assert.equal(away.walks, 5);
  assert.equal(away.totalBases, 21);
});

test('un juego final reemplaza IN y persiste marcador, H/HR/E e innings', () => {
  const row = buildBaseballResultRow({
    gamePk: 823919, sportId: 1, isLive: false, isFinal: true,
    inning: 9, inningHalf: 'End',
    home: { score: 4, hits: 9, errors: 1 },
    away: { score: 8, hits: 9, errors: 0 },
    innings: [{ number: 1, home: 0, away: 2 }, { number: 9, home: 0, away: 0 }],
  }, {
    fixture_id: 823919, status: 'IN', home_score: 4, away_score: 8,
  }, boxscore, '2026-08-02', new Date('2026-08-03T04:30:00Z'));

  assert.equal(row.status, 'FT');
  assert.equal(row.home_hits, 9);
  assert.equal(row.away_stats.homeRuns, 4);
  assert.equal(row.home_stats.homeRuns, 0);
  assert.equal(row.home_errors, 1);
  assert.deepEqual(row.innings[0], { number: 1, home: 0, away: 2 });
  assert.equal(row.finished_at, '2026-08-03T04:30:00.000Z');
  assert.equal(baseballResultRowChanged({ fixture_id: 823919, status: 'IN' }, row), true);
});

test('un FT durable nunca regresa a no iniciado por un snapshot transitorio', () => {
  const existing = {
    fixture_id: 10, league_id: 1, date: '2026-08-02', status: 'FT',
    inning: 9, inning_half: 'end', home_score: 4, away_score: 8,
    home_hits: 9, away_hits: 9, home_errors: 1, away_errors: 0,
    innings: [{ number: 9, home: 0, away: 0 }],
    home_stats: { homeRuns: 0 }, away_stats: { homeRuns: 4 },
    finished_at: '2026-08-03T04:30:00.000Z',
  };
  const row = buildBaseballResultRow({
    gamePk: 10, sportId: 1, isLive: false, isFinal: false,
    home: { score: null }, away: { score: null }, innings: [],
  }, existing, null, '2026-08-02', new Date('2026-08-03T05:00:00Z'));

  assert.equal(row.status, 'FT');
  assert.equal(row.home_score, 4);
  assert.equal(row.away_stats.homeRuns, 4);
  assert.equal(baseballResultRowChanged(existing, row), false);
});
