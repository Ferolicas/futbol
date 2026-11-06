import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeApiSportsOdds } from '../lib/api-sports-multisport.js';
import { basketballPeriodStatsFromPlays, espnSportsInternals } from '../lib/espn-sports-api.js';
import { normalizeTeamStatistics } from '../lib/multisport-store.js';
import { settleMarketSelection } from '../lib/market-settlement.js';
import { buildTeamBreakdown, computeMultisportEmpiricalPlayerMarkets } from '../lib/multisport-empirical-engine.js';
import { multisportProviderInternals } from '../lib/multisport-providers.js';
import { normalizeApiNbaGame } from '../lib/nba-stats-api.js';

const fixture = { teams: { home: { name: 'Charlotte Hornets' }, away: { name: 'Boston Celtics' } } };
const bet365 = (bets) => [{ bookmakers: [{ id: 4, name: 'Bet365', bets }] }];

test('NBA: los mercados "1st Qtr" son del cuarto y no contaminan el partido', () => {
  const odds = normalizeApiSportsOdds(bet365([
    { id: 2, name: 'Home/Away', values: [{ value: 'Home', odd: '3.65' }, { value: 'Away', odd: '1.30' }] },
    { id: 19, name: 'Home/Away - 1st Qtr', values: [{ value: 'Home', odd: '2.50' }, { value: 'Away', odd: '1.55' }] },
    { id: 4, name: 'Over/Under', values: [{ value: 'Over 209.5', odd: '1.88' }, { value: 'Under 209.5', odd: '1.93' }] },
    { id: 16, name: 'Over/Under 1st Qtr', values: [{ value: 'Over 54.5', odd: '1.90' }, { value: 'Under 54.5', odd: '1.90' }] },
    { id: 23, name: 'Home Team Total Points (1st Quarter)', values: [{ value: 'Over 26.5', odd: '1.83' }] },
  ]), fixture, { sport: 'basketball', bookmakers: ['Bet365'] });
  assert.equal(odds.moneyline.home.odd, 3.65);
  assert.equal(odds.moneyline.away.odd, 1.3);
  assert.deepEqual(Object.keys(odds.totals), ['209.5']);
  assert.equal(odds.periods.quarter1.moneyline.home.odd, 2.5);
  assert.equal(odds.periods.quarter1.totals['54.5'].over.odd, 1.9);
  assert.equal(odds.periods.quarter1.teamTotals.home['26.5'].over.odd, 1.83);
});

test('NBA: el hándicap del visitante se guarda sobre su propio eje', () => {
  const odds = normalizeApiSportsOdds(bet365([
    { id: 3, name: 'Asian Handicap', values: [{ value: 'Home +7.5', odd: '1.95' }, { value: 'Away +7.5', odd: '1.76' }] },
    { id: 17, name: 'Asian Handicap 1st Qtr', values: [{ value: 'Home +2.5', odd: '1.86' }, { value: 'Away +2.5', odd: '1.95' }] },
  ]), fixture, { sport: 'basketball', bookmakers: ['Bet365'] });
  assert.equal(odds.spreads.home['7.5'].odd, 1.95);
  assert.equal(odds.spreads.away['-7.5'].odd, 1.76);
  assert.equal(odds.spreads.away['7.5'], undefined);
  assert.equal(odds.periods.quarter1.spreads.away['-2.5'].odd, 1.95);
});

test('NBA: los mercados compuestos no se leen como totales y los hitos son props de puntos', () => {
  const odds = normalizeApiSportsOdds(bet365([
    { id: 226, name: 'Result/Total Goals (1st Half)', values: [{ value: 'Home/Over 108.5', odd: '5.50' }] },
    { id: 43, name: 'Home Winning Margin (12-Way)', values: [{ value: 'Home/Over 210.5', odd: '7.00' }] },
    { id: 38, name: '3Way Result - 2nd Qtr', values: [{ value: 'Home', odd: '2.60' }] },
    { id: 239, name: 'Player Points Milestones', values: [{ value: 'Jayson Tatum - 25', odd: '1.54' }] },
  ]), fixture, { sport: 'basketball', bookmakers: ['Bet365'] });
  assert.deepEqual(odds.periods, {});
  assert.deepEqual(odds.totals, {});
  assert.deepEqual(odds.moneyline, {});
  const tatum = odds.playerProps.points.jaysontatum;
  assert.equal(tatum.lines['24.5'].over.odd, 1.54);
  assert.equal(tatum.lines['24.5'].over.threshold, 25);
});

test('ESPN: puntos y rebotes por cuarto salen del jugada a jugada', () => {
  const play = (period, athlete, extra) => ({ period: { number: period }, participants: [{ athlete: { id: athlete } }], ...extra });
  const plays = [
    play(1, '7', { scoringPlay: true, scoreValue: 3, type: { text: 'Jump Shot' }, text: 'A makes three' }),
    { period: { number: 1 }, scoringPlay: true, scoreValue: 2, type: { text: 'Layup' }, text: 'B makes layup (A assists)', participants: [{ athlete: { id: '8' } }, { athlete: { id: '7' } }] },
    play(1, '7', { scoringPlay: false, type: { text: 'Defensive Rebound' } }),
    { period: { number: 1 }, type: { text: 'Defensive Rebound' }, participants: [] },
    play(2, '7', { scoringPlay: true, scoreValue: 1, type: { text: 'Free Throw - 1 of 2' }, text: 'A makes free throw' }),
  ];
  const stats = basketballPeriodStatsFromPlays(plays);
  assert.deepEqual(stats.get('7').get(1), { points: 3, rebounds: 1, assists: 1, threePointersMade: 1 });
  assert.equal(stats.get('7').get(2).points, 1);

  const payload = {
    plays,
    boxscore: { players: [{ team: { id: '2', displayName: 'Boston Celtics', abbreviation: 'BOS' }, statistics: [{
      names: ['MIN', 'PTS', 'REB'], keys: ['minutes', 'points', 'rebounds'],
      athletes: [
        { athlete: { id: '7', displayName: 'A' }, starter: true, stats: ['30', '4', '1'] },
        { athlete: { id: '8', displayName: 'B' }, starter: false, stats: ['12', '9', '0'] },
      ],
    }] }] },
  };
  const [team] = espnSportsInternals.playerGroups(payload, espnSportsInternals.COMPETITIONS.nba);
  const a = normalizeTeamStatistics(team.players[0].stats);
  assert.equal(a.rebounds, 1);
  assert.equal(a.q1Points, 3);
  assert.equal(a.q1Rebounds, 1);
  // B: el jugada a jugada (2) no reproduce su boxscore (9) → sin desglose.
  const b = normalizeTeamStatistics(team.players[1].stats);
  assert.equal(b.points, 9);
  assert.equal(b.q1Points, undefined);
});

test('NBA: un prop de jugador se liquida con el boxscore guardado', () => {
  const game = { status: { short: 'FT' }, scores: { home: { total: 100 }, away: { total: 110 } } };
  const selection = { id: 'player-points-NBA:PLAYER:7-24.5-over', line: 24.5, side: 'over' };
  const won = settleMarketSelection({ sport: 'basketball', selection, game, liveResult: { player_stats: { 'NBA:PLAYER:7': { stats: { points: 31 } } } } });
  assert.equal(won.status, 'won');
  const q1 = settleMarketSelection({
    sport: 'basketball', game,
    selection: { id: 'player-q1Points-NBA:PLAYER:7-5.5-over', line: 5.5, side: 'over' },
    liveResult: { players: [{ players: [{ id: 'NBA:PLAYER:7', stats: { q1Points: 4 } }] }] },
  });
  assert.equal(q1.status, 'lost');
  const absent = settleMarketSelection({ sport: 'basketball', selection, game, liveResult: { player_stats: {} } });
  assert.equal(absent.status, 'void');
});

test('NBA: el desglose separa temporada, localía y h2h con conteos crudos', () => {
  const row = (id, isHome, opponent, own, other, q1, q1Against, season = '2026-2027') => ({
    fixture_id: id, kickoff: `2026-11-0${id}T00:00:00Z`, team_id: '1', opponent_id: opponent, season, is_home: isHome,
    score_for: own, score_against: other, period_scores: [q1, 0, 0, 0], period_scores_against: [q1Against, 0, 0, 0], stats: { rebounds: 40 },
  });
  const rows = [row(1, true, '9', 120, 100, 30, 25), row(2, false, '9', 90, 110, 20, 28), row(3, true, '5', 105, 104, 27, 27)];
  const result = buildTeamBreakdown(rows, { season: '2026-2027', teams: { home: { id: '1' }, away: { id: '9' } } }, 'home', {
    totals: { 215.5: { over: { odd: 1.9 }, under: { odd: 1.9 } }, 220.5: { over: { odd: 2.4 }, under: { odd: 1.5 } } },
    spreads: { home: { '-4.5': { odd: 1.9 } }, away: { '4.5': { odd: 1.9 } } },
  });
  assert.equal(result.venueLabel, 'local');
  assert.equal(result.segments.season.n, 3);
  assert.equal(result.segments.venue.n, 2);
  assert.equal(result.segments.h2h.n, 2);
  assert.equal(result.segments.venue.pointsFor, 112.5);
  const market = (key) => result.markets.find((entry) => entry.key === key);
  assert.deepEqual(market('win').segments.venue, { n: 2, hits: 2 });
  assert.deepEqual(market('q1Win').segments.season, { n: 3, hits: 1 });
  assert.equal(market('total').line, 215.5);
  assert.deepEqual(market('total').segments.season, { n: 3, hits: 1 });
  assert.equal(market('spread').line, -4.5);
  assert.deepEqual(market('spread').segments.venue, { n: 2, hits: 1 });
});

test('NBA: los mercados de jugador separan cortes y no promedian entre franquicias', async () => {
  const base = { player_id: '7', player_name: 'Base', competition_id: 'NBA', is_starter: true };
  const rows = [
    { ...base, fixture_id: 'a', kickoff: '2026-10-25T00:00:00Z', team_id: '3', opponent_id: '2', season: '2026-2027', is_home: true, stats: { points: 30, q1Points: 9 } },
    { ...base, fixture_id: 'b', kickoff: '2026-10-27T00:00:00Z', team_id: '1', opponent_id: '5', season: '2026-2027', is_home: false, stats: { points: 10, q1Points: 2 } },
    { ...base, fixture_id: 'c', kickoff: '2026-10-29T00:00:00Z', team_id: '1', opponent_id: '2', season: '2026-2027', is_home: true, stats: { points: 28, q1Points: 8 } },
  ];
  const pool = { async query(sql) { assert.match(sql, /basketball_engine_player_stats/); return { rows }; } };
  const result = await computeMultisportEmpiricalPlayerMarkets(pool, {
    sport: 'basketball',
    fixture: { date: '2026-11-06T00:00:00Z', season: '2026-2027', league: { id: 'NBA' }, teams: { home: { id: '1' }, away: { id: '2' } } },
    players: [{ id: '7', name: 'Base', teamId: '1', starter: true }],
    playerLines: { points: { base: [24.5] } },
    config: { currentShare: .65, venueBoost: 1, opponentBoost: 1, competitionBoost: 1, starterBoost: 1, lineupBoost: 1 },
  });
  const points = result.points[0];
  assert.equal(points.side, 'home');
  assert.deepEqual(points.splits['24.5'].season, { n: 3, hits: 2 });
  assert.deepEqual(points.splits['24.5'].venue, { n: 2, hits: 2 });
  assert.deepEqual(points.splits['24.5'].h2h, { n: 2, hits: 2 });
  // Un solo participante: 2 de 3, no (1/1 + 1/2) / 2.
  assert.ok(Math.abs(points.lineSides['24.5'].over.rawProbability - 2 / 3) < 1e-9);
  assert.ok(points.lineSides['24.5'].over.evidence, 'la línea ofrecida conserva evidencia para la fiabilidad');
  assert.equal(result.q1Points[0].mean, 6.33);
});

test('NBA: el respaldo fecha el ID en hora del Este y cruza a los Clippers', () => {
  const game = normalizeApiNbaGame({
    id: 1, date: { start: '2026-11-07T03:00:00.000Z' }, status: { short: 1, long: 'Scheduled' },
    teams: { home: { name: 'Los Angeles Lakers', code: 'LAL' }, visitors: { name: 'LA Clippers', code: 'LAC' } },
    scores: { home: {}, visitors: {} },
  }, '2026-11-07');
  assert.equal(game.id, 'NBA-2026-11-06-LAC-LAL');
  const candidate = { league: { id: 12 }, teams: { home: { name: 'Los Angeles Lakers' }, away: { name: 'Los Angeles Clippers' } } };
  assert.equal(multisportProviderInternals.nbaTeamsMatch(candidate, game), true);
  assert.equal(multisportProviderInternals.nbaTeamsMatch({ ...candidate, league: { id: 99 } }, game), false);
  assert.equal(multisportProviderInternals.withinApiSportsDateWindow('2026-11-07', new Date('2026-11-06T15:00:00Z')), true);
  assert.equal(multisportProviderInternals.withinApiSportsDateWindow('2026-11-08', new Date('2026-11-06T15:00:00Z')), false);
});
