const test = require('node:test');
const assert = require('node:assert/strict');

// buildMultisportCombinada comparte módulo con la capa de persistencia. El pool
// no abre conexión hasta ejecutar una consulta, pero necesita un contrato de
// configuración válido al importar.
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:1/cfanalisis_test';
process.env.DATABASE_SSL ||= 'false';

const { normalizeApiSportsOdds } = require('../lib/api-sports-multisport.js');
const { buildMultisportCombinada } = require('../lib/multisport-analysis.js');
const { buildBaseballApuestaDelDia, buildCustomBaseballCombinada } = require('../lib/baseball-combinada.js');

function probability(value) {
  return { probability: Math.min(95, value * 100), rawProbability: value, evidence: { n: 10, hits: value * 10 } };
}

const fixture = {
  teams: {
    home: { id: 1, name: 'Equipo Local' },
    away: { id: 2, name: 'Equipo Visitante' },
  },
};

const payload = [{
  bookmakers: [
    {
      id: 2,
      name: 'Bet365',
      bets: [
        { id: 1, name: 'Home/Away', values: [{ value: 'Home', odd: '1.80' }, { value: 'Away', odd: '2.10' }] },
        { id: 5, name: 'Over/Under', values: [
          { value: 'Over 8.5', odd: '1.74' }, { value: 'Under 8.5', odd: '1.95' },
          { value: 'Under 12.5', odd: '1.19' },
        ] },
        { id: 41, name: 'Total Hits', values: [{ value: 'Over 18.5', odd: '2.90' }, { value: 'Under 18.5', odd: '1.38' }] },
        { id: 11, name: 'Over/Under (1st Inning)', values: [{ value: 'Over 0.5', odd: '1.66' }, { value: 'Under 0.5', odd: '2.20' }] },
        { id: 31, name: 'Over/Under (1st 3 Innings)', values: [{ value: 'Over 2.5', odd: '1.91' }, { value: 'Under 2.5', odd: '1.85' }] },
        { id: 60, name: 'Away Total Hits', values: [{ value: 'Over 6.5', odd: '1.76' }, { value: 'Under 6.5', odd: '2.00' }] },
        { id: 49, name: 'Player Total Bases', values: [{ value: 'Rafael Devers - Over 1.5', odd: '1.82' }, { value: 'Rafael Devers - Under 1.5', odd: '1.96' }] },
        { id: 73, name: 'Player Runs', values: [{ value: 'Rafael Devers - Over 0.5', odd: '2.05' }, { value: 'Rafael Devers - Under 0.5', odd: '1.72' }] },
        { id: 76, name: 'Player Hits', values: [{ value: 'Rafael Devers - Over 0.5', odd: '1.42' }, { value: 'Rafael Devers - Under 0.5', odd: '2.75' }] },
        { id: 78, name: 'Pitcher Strikeouts', values: [{ value: 'Chris Sale - Over 5.5', odd: '1.90' }, { value: 'Chris Sale - Under 5.5', odd: '1.88' }] },
        { id: 9, name: 'Odd/Even (Including OT)', values: [{ value: 'Odd', odd: '1.92' }, { value: 'Even', odd: '1.92' }] },
        { id: 23, name: 'Correct Score', values: [{ value: '5:3', odd: '21.00' }] },
        { id: 32, name: 'Extra Innings', values: [{ value: 'Yes', odd: '7.00' }, { value: 'No', odd: '1.10' }] },
        { id: 33, name: 'First Team To Score', values: [{ value: 'Home', odd: '1.72' }, { value: 'Away', odd: '2.10' }] },
        { id: 45, name: 'Last Team To Score', values: [{ value: 'Home', odd: '1.70' }, { value: 'Away', odd: '2.15' }] },
        { id: 65, name: 'Home Odd/Even (OT)', values: [{ value: 'Odd', odd: '1.90' }, { value: 'Even', odd: '1.94' }] },
        { id: 66, name: 'Away Odd/Even (OT)', values: [{ value: 'Odd', odd: '1.91' }, { value: 'Even', odd: '1.93' }] },
        { id: 83, name: 'Team With Highest Scoring', values: [{ value: 'Home', odd: '1.75' }, { value: 'Draw', odd: '9.00' }, { value: 'Away', odd: '2.05' }] },
        { id: 69, name: 'Result/Total Goals', values: [{ value: 'Home/Over 8.5', odd: '4.10' }] },
        { id: 2, name: 'Asian Handicap', values: [{ value: 'Home -1.5', odd: '3.20' }, { value: 'Away +1.5', odd: '2.05' }] },
        { id: 6, name: 'Over/Under (1st 5 Innings)', values: [{ value: 'Over 4.5', odd: '1.80' }, { value: 'Under 4.5', odd: '1.95' }] },
        { id: 3, name: 'Asian Handicap (1st 5 Innings)', values: [{ value: 'Home +0', odd: '2.15' }, { value: 'Away +0', odd: '1.68' }] },
        { id: 43, name: 'Home Team Total Goals (Including OT)', values: [{ value: 'Over 3.5', odd: '1.83' }, { value: 'Under 3.5', odd: '1.90' }] },
        { id: 44, name: 'Away Team Total Goals (Including OT)', values: [{ value: 'Over 4.5', odd: '1.76' }, { value: 'Under 4.5', odd: '2.00' }] },
      ],
    },
    {
      id: 6,
      name: 'Bwin',
      bets: [{ id: 5, name: 'Over/Under', values: [{ value: 'Under 8.5', odd: '2.50' }] }],
    },
  ],
}];

test('Baseball separa carreras, hits y mercados combinados del catálogo Bet365', () => {
  const odds = normalizeApiSportsOdds(payload, fixture, { sport: 'baseball', bookmakers: ['Bet365'] });

  assert.deepEqual(Object.keys(odds.totals).sort(), ['12.5', '8.5']);
  assert.equal(odds.totals[8.5].over.odd, 1.74);
  assert.equal(odds.totals[8.5].under.odd, 1.95);
  assert.equal(odds.totals[8.5].under.bookmaker, 'Bet365');
  assert.equal(odds.totals[8.5].under.marketName, 'Over/Under');
  assert.equal(odds.totals[18.5], undefined);
  assert.equal(odds.periods.first5.totals[4.5].under.odd, 1.95);
  assert.equal(odds.periods.first5.spreads.home[0].odd, 2.15);
  assert.equal(odds.periods.inning1.totals[0.5].over.odd, 1.66);
  assert.equal(odds.periods.first3.totals[2.5].under.odd, 1.85);
  assert.equal(odds.teamTotals.home[3.5].over.odd, 1.83);
  assert.equal(odds.teamTotals.away[4.5].under.odd, 2);
  assert.equal(odds.statistics.hits.total[18.5].over.odd, 2.9);
  assert.equal(odds.statistics.hits.away[6.5].under.odd, 2);
  assert.equal(odds.playerProps.totalBases.rafaeldevers.lines[1.5].over.odd, 1.82);
  assert.equal(odds.playerProps.runs.rafaeldevers.lines[0.5].under.odd, 1.72);
  assert.equal(odds.playerProps.hits.rafaeldevers.lines[0.5].over.odd, 1.42);
  assert.equal(odds.playerProps.strikeouts.chrissale.lines[5.5].under.odd, 1.88);
  assert.equal(odds.specials.totalParity.odd.odd, 1.92);
  assert.equal(odds.specials.firstTeamScore.home.odd, 1.72);
  assert.equal(odds.specials.lastTeamScore.away.odd, 2.15);
  assert.equal(odds.specials.extraInnings.yes.odd, 7);
  assert.equal(odds.specials.teamParity.home.even.odd, 1.94);
  assert.equal(odds.specials.highestScoring.draw.odd, 9);
  assert.equal(odds.specials.correctScore['5:3'].odd, 21);
  assert.equal(odds.specials.resultTotals['Home/Over 8.5'].odd, 4.1);
  assert.deepEqual(odds.rawBookmakers, [{ id: 2, name: 'Bet365' }]);
  assert.ok(odds.catalog.every((entry) => entry.bookmaker === 'Bet365'));
  assert.ok(odds.catalog.some((entry) => entry.marketName === 'Total Hits'));
  assert.ok(odds.catalog.some((entry) => entry.marketName === 'Result/Total Goals'));
});

test('Baseball publica solo selecciones cruzadas con Bet365 y cuota mínima 1.20', () => {
  const odds = normalizeApiSportsOdds(payload, fixture, { sport: 'baseball', bookmakers: ['Bet365'] });
  const prediction = {
    sport: 'baseball',
    moneyline: { home: probability(.74), away: probability(.26) },
    totals: { lines: {
      8.5: { over: probability(.10), under: probability(.90) },
      12.5: { over: probability(.01), under: probability(.99) },
      18.5: { over: probability(0), under: probability(1) },
    } },
    spread: {
      homeMinus: probability(.20), awayPlus: probability(.80),
      awayMinus: probability(.10), homePlus: probability(.90),
    },
    period: {
      moneyline: { home: probability(.84), away: probability(.12), draw: probability(.04) },
      totals: { 4.5: { over: probability(.14), under: probability(.86) } },
    },
    teamTotals: {
      home: { 3.5: { over: probability(.85), under: probability(.15) } },
      away: { 4.5: { over: probability(.31), under: probability(.69) } },
    },
  };

  const result = buildMultisportCombinada(prediction, odds, fixture);

  assert.ok(result.selectable.length > 0);
  assert.ok(result.selectable.every((selection) => selection.bookmaker === 'Bet365'));
  assert.ok(result.selectable.every((selection) => selection.odd >= 1.20));
  assert.ok(result.selectable.every((selection) => selection.rawProbability >= 65));
  assert.ok(result.selectable.every((selection) => selection.bookmakerMarket));
  assert.ok(result.selectable.every((selection) => selection.bookmakerSelection));
  assert.ok(result.selectable.some((selection) => selection.id === 'total-8.5-under'));
  assert.ok(result.selectable.some((selection) => selection.id === 'first5-total-4.5-under'));
  assert.ok(result.selectable.some((selection) => selection.id === 'team-total-home-3.5-over'));
  assert.ok(result.selectable.some((selection) => selection.id === 'ml-home'));
  assert.ok(result.selectable.some((selection) => selection.id === 'team-total-away-4.5-under'));
  assert.ok(result.selectable.every((selection) => !selection.id.includes('18.5')));
  assert.ok(result.selectable.every((selection) => !selection.id.includes('12.5')));
  assert.ok(result.selectable.every((selection) => !/\bF5\b/i.test(selection.name)));
  assert.ok(result.selections.every((selection) => selection.rawProbability >= 65));
  assert.equal(result.selectableThreshold, 65);
  assert.equal(result.highlightThreshold, 65);
  assert.equal(result.dailyThreshold, 90);
});

test('Baseball conserva todas las líneas exactas y cruza props por nombre de jugador', () => {
  const odds = normalizeApiSportsOdds(payload, fixture, { sport: 'baseball', bookmakers: ['Bet365'] });
  const prediction = {
    sport: 'baseball',
    moneyline: {}, totals: { lines: {} }, teamTotals: { home: {}, away: {} },
    spreads: { home: {}, away: {} }, statistics: {
      hits: {
        total: { 18.5: { over: probability(.66), under: probability(.34) } },
        home: {}, away: { 6.5: { over: probability(.72), under: probability(.28) } },
        label: 'hits',
      },
    },
    periods: {
      inning1: {
        label: '1.ª entrada', totals: { 0.5: { over: probability(.67), under: probability(.33) } },
        moneyline: {}, spreads: {}, run: {}, teamTotals: {},
      },
      first3: {
        label: 'primeras 3 entradas', totals: { 2.5: { over: probability(.65), under: probability(.35) } },
        moneyline: {}, spreads: {}, run: {}, teamTotals: {},
      },
    },
    specials: {
      totalParity: { odd: probability(.66), even: probability(.34) },
      teamParity: { home: {}, away: {} },
      firstTeamScore: { home: probability(.70), away: probability(.30) },
      lastTeamScore: { home: probability(.35), away: probability(.65) },
      extraInnings: { yes: probability(.10), no: probability(.90) },
      highestScoring: { home: probability(.68), away: probability(.30), draw: probability(.02) },
      correctScore: { '5:3': probability(.65) },
      halfFull: {},
      resultTotals: { 'Home/Over 8.5': probability(.65) },
    },
  };
  const lineSides = {
    0.5: { over: probability(.80), under: probability(.20) },
    1.5: { over: probability(.65), under: probability(.35) },
    5.5: { over: probability(.70), under: probability(.30) },
  };
  const playerProbabilities = {
    hits: [{ id: 10, name: 'Rafael Devers', lineSides }],
    runs: [{ id: 10, name: 'Rafael Devers', lineSides }],
    totalBases: [{ id: 10, name: 'Rafael Devers', lineSides }],
    strikeouts: [{ id: 20, name: 'Chris Sale', lineSides }],
  };

  const result = buildMultisportCombinada(prediction, odds, fixture, { playerProbabilities });
  assert.ok(result.selectable.some((selection) => selection.id === 'inning1-total-0.5-over'));
  assert.ok(result.selectable.some((selection) => selection.id === 'first3-total-2.5-over'));
  assert.ok(result.selectable.some((selection) => selection.id === 'stat-hits-total-18.5-over'));
  assert.ok(result.selectable.some((selection) => selection.id === 'stat-hits-away-6.5-over'));
  assert.ok(result.selectable.some((selection) => selection.id === 'player-hits-10-0.5-over'));
  assert.ok(result.selectable.some((selection) => selection.id === 'player-runs-10-0.5-over'));
  assert.ok(result.selectable.some((selection) => selection.id === 'player-totalBases-10-1.5-over'));
  assert.ok(result.selectable.some((selection) => selection.id === 'player-strikeouts-20-5.5-over'));
  assert.ok(result.selectable.some((selection) => selection.id === 'special-total-parity-odd'));
  assert.ok(result.selectable.some((selection) => selection.id === 'special-first-score-home'));
  assert.ok(result.selectable.some((selection) => selection.id === 'special-last-score-away'));
  assert.ok(result.selectable.some((selection) => selection.id === 'special-correct-score-5-3'));
  assert.ok(result.selectable.some((selection) => selection.id.startsWith('special-result-total-')));
});

test('las combinadas descartan selecciones viejas o ajenas al catálogo Bet365 actual', () => {
  const canonical = {
    id: 'total-8.5-under', category: 'total-8.5', marketLabel: 'Total de carreras',
    name: 'Menos de 8.5 carreras', probability: 91, rawProbability: 91.4,
    odd: 1.95, bookmaker: 'Bet365', bookmakerMarket: 'Over/Under', bookmakerSelection: 'Under 8.5',
  };
  const game = {
    id: 99,
    status: { short: 'NS' },
    teams: fixture.teams,
    analysis: { combinada: { selectable: [canonical], selections: [canonical, { ...canonical, id: 'bwin', bookmaker: 'Bwin' }] } },
  };

  const custom = buildCustomBaseballCombinada({
    99: {
      'total-8.5-under': { ...canonical, odd: 9.99 },
      disappeared: { ...canonical, id: 'disappeared' },
    },
  }, { 99: game });
  assert.equal(custom.selections.length, 1);
  assert.equal(custom.selections[0].odd, 1.95);
  assert.equal(custom.selections[0].bookmaker, 'Bet365');

  const daily = buildBaseballApuestaDelDia([game], { minProb: 90 });
  assert.equal(daily.selections.length, 1);
  assert.equal(daily.selections[0].bookmaker, 'Bet365');
});
