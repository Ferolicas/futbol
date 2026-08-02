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
  assert.equal(odds.teamTotals.home[3.5].over.odd, 1.83);
  assert.equal(odds.teamTotals.away[4.5].under.odd, 2);
  assert.deepEqual(odds.rawBookmakers, [{ id: 2, name: 'Bet365' }]);
  assert.ok(odds.catalog.every((entry) => entry.bookmaker === 'Bet365'));
  assert.ok(odds.catalog.every((entry) => entry.marketName !== 'Total Hits'));
  assert.ok(odds.catalog.every((entry) => entry.marketName !== 'Result/Total Goals'));
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
  assert.ok(result.selectable.every((selection) => selection.rawProbability >= 70));
  assert.ok(result.selectable.every((selection) => selection.bookmakerMarket));
  assert.ok(result.selectable.every((selection) => selection.bookmakerSelection));
  assert.ok(result.selectable.some((selection) => selection.id === 'total-8.5-under'));
  assert.ok(result.selectable.some((selection) => selection.id === 'first5-total-4.5-under'));
  assert.ok(result.selectable.some((selection) => selection.id === 'team-total-home-3.5-over'));
  assert.ok(result.selectable.some((selection) => selection.id === 'ml-home'));
  assert.ok(result.selectable.every((selection) => selection.id !== 'team-total-away-4.5-under'));
  assert.ok(result.selectable.every((selection) => !selection.id.includes('18.5')));
  assert.ok(result.selectable.every((selection) => !selection.id.includes('12.5')));
  assert.ok(result.selectable.every((selection) => !/\bF5\b/i.test(selection.name)));
  assert.ok(result.selections.every((selection) => selection.rawProbability >= 70));
  assert.equal(result.selectableThreshold, 70);
  assert.equal(result.highlightThreshold, 70);
  assert.equal(result.dailyThreshold, 90);
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
