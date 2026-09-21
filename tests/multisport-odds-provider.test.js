import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { normalizeApiSportsOdds } from '../lib/api-sports-multisport.js';
import { multisportProviderInternals } from '../lib/multisport-providers.js';

test('adapta una cartelera Bet365 de The Odds API sin modificar probabilidades del motor', () => {
  const event = {
    id: 'event-1', home_team: 'New York Yankees', away_team: 'Boston Red Sox',
    bookmakers: [{ key: 'bet365', title: 'Bet365', markets: [
      { key: 'h2h', outcomes: [{ name: 'New York Yankees', price: 1.7 }, { name: 'Boston Red Sox', price: 2.2 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 8.5, price: 1.9 }, { name: 'Under', point: 8.5, price: 1.91 }] },
      { key: 'spreads', outcomes: [{ name: 'New York Yankees', point: -1.5, price: 2.1 }, { name: 'Boston Red Sox', point: 1.5, price: 1.75 }] },
    ] }],
  };
  const fixture = { teams: { home: { name: event.home_team }, away: { name: event.away_team } } };
  const payload = multisportProviderInternals.theOddsApiSportsPayload(event);
  const odds = normalizeApiSportsOdds(payload, fixture, { sport: 'baseball', bookmakers: ['Bet365'] });
  assert.equal(odds.moneyline.home.odd, 1.7);
  assert.equal(odds.totals['8.5'].over.odd, 1.9);
  assert.equal(odds.spreads.home['-1.5'].odd, 2.1);
  assert.deepEqual(odds.rawBookmakers, [{ id: 'bet365', name: 'Bet365' }]);
});

test('MLB deja de gastar API-Baseball para mapear IDs y falla cerrado sin Bet365', () => {
  const source = fs.readFileSync(new URL('../lib/multisport-providers.js', import.meta.url), 'utf8');
  const featuredStart = source.indexOf('const featured = await fetchMultisportBet365Event');
  const baseballClosed = source.indexOf("if (config.key === 'baseball') return", featuredStart);
  const legacyMapping = source.indexOf('apiSportsFixtureIdFor(config.key', featuredStart);
  assert.ok(featuredStart > 0);
  assert.ok(baseballClosed > featuredStart);
  assert.ok(legacyMapping > baseballClosed, 'el retorno MLB debe ocurrir antes del mapeo API-Sports');
  assert.match(source.slice(baseballClosed, legacyMapping), /sin-cuota-bet365/);
});

test('el presupuesto por defecto de The Odds API respeta aproximadamente 500 créditos mensuales', () => {
  const source = fs.readFileSync(new URL('../lib/odds-api.js', import.meta.url), 'utf8');
  assert.match(source, /DEFAULT_DAILY_CREDIT_CAP = 16/);
  assert.match(source, /MULTISPORT_DAILY_RESERVE = 12/);
  assert.match(source, /bookmakers: 'bet365'/);
  assert.match(source, /h2h,spreads,totals/);
  assert.match(source, /Los vacíos también se cachean/);
});
