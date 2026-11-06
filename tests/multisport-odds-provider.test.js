import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:1/cfanalisis_test';
process.env.DATABASE_SSL ||= 'false';

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

test('API-Sports (mismo proveedor que ya trae Bet365 en fútbol) es la fuente PRIMARIA de cuotas para béisbol/basket/NFL, The Odds API queda como respaldo', () => {
  const source = fs.readFileSync(new URL('../lib/multisport-providers.js', import.meta.url), 'utf8');
  const fnStart = source.indexOf('export async function getSportOdds');
  const mapping = source.indexOf('apiSportsFixtureIdFor(config.key', fnStart);
  const featured = source.indexOf('const featured = await tryFeaturedOdds', fnStart);
  assert.ok(fnStart > 0);
  assert.ok(mapping > fnStart, 'debe mapear el fixture de API-Sports dentro de getSportOdds');
  assert.ok(featured > mapping, 'The Odds API debe consultarse DESPUÉS de intentar API-Sports, no antes');
  // Ya no existe el bloqueo especial de béisbol que impedía usar API-Baseball
  // partido a partido y fallaba cerrado apenas The Odds API no respondía.
  assert.doesNotMatch(source.slice(fnStart, featured), /if \(config\.key === 'baseball'\) return/);
});

test('getSportOdds propaga emptyTtl a fetchMultisportBet365Event (no solo ttl)', () => {
  const source = fs.readFileSync(new URL('../lib/multisport-providers.js', import.meta.url), 'utf8');
  const start = source.indexOf('const featured = await fetchMultisportBet365Event');
  const call = source.slice(start, source.indexOf('}).catch((error) => {', start));
  assert.match(call, /emptyTtl:\s*options\.emptyTtl/);
});

test('NCAA no pasa por API-Sports partido a partido salvo el cupo explícito de baloncesto', () => {
  const source = fs.readFileSync(new URL('../lib/multisport-providers.js', import.meta.url), 'utf8');
  const ncaaStart = source.indexOf("if (/^espn-ncaa/.test");
  const ncaaEnd = source.indexOf('// Los planes gratuitos de API-Sports', ncaaStart);
  assert.ok(ncaaStart > 0);
  assert.ok(ncaaEnd > ncaaStart);
  const ncaaBlock = source.slice(ncaaStart, ncaaEnd);
  // Una jornada universitaria tiene 100-150+ partidos: pedirlos todos agota el
  // presupuesto diario compartido con la NBA. La única excepción es el
  // baloncesto, donde Bet365 solo existe en API-Basketball, y solo cuando el
  // pase de análisis marca el partido dentro de su cupo (`ncaaApiSports`).
  const basketballStart = ncaaBlock.indexOf("if (config.key === 'basketball') {");
  const footballStart = ncaaBlock.indexOf('const featuredNcaa = await tryFeaturedOdds(config, game, options);');
  assert.ok(basketballStart > 0 && footballStart > basketballStart);
  const basketballBlock = ncaaBlock.slice(basketballStart, footballStart);
  const gate = basketballBlock.indexOf("if (options.ncaaApiSports !== true) return emptyMultisportOdds(");
  const firstProviderCall = basketballBlock.search(/apiSportsFixtureIdFor|getApiSportsOddsForGame/);
  assert.ok(gate > 0 && gate < firstProviderCall, 'sin el permiso del cupo no se llama al proveedor');
  assert.doesNotMatch(basketballBlock, /tryFeaturedOdds/, 'The Odds API no publica Bet365 para la NCAA de baloncesto');
  // Fútbol americano universitario: cartelera completa de The Odds API, nunca
  // API-Sports partido a partido.
  const footballBlock = ncaaBlock.slice(footballStart);
  assert.doesNotMatch(footballBlock, /apiSportsFixtureIdFor|getApiSportsOddsForGame/);
  assert.doesNotMatch(ncaaBlock.slice(0, basketballStart), /apiSportsFixtureIdFor|getApiSportsOddsForGame/);
});

test('el cron de béisbol (cada 15 min) ya no fuerza un TTL de cuota más corto que su propio intervalo', () => {
  const source = fs.readFileSync(
    new URL('../apps/cfanalisis-worker/src/jobs/baseball/analyze.js', import.meta.url),
    'utf8',
  );
  // La guardia de cobertura corre cada 15 min: un TTL de cuota menor a eso
  // repite la misma llamada de cartelera completa en cada tick y agota en
  // ~1h el cupo diario compartido con NBA/NCAAB/NFL/NCAAF.
  assert.doesNotMatch(source, /oddsTtl:\s*10\s*\*\s*60\b/);
  assert.match(source, /oddsTtl:\s*20\s*\*\s*3600/);
  assert.match(source, /oddsEmptyTtl:\s*2\s*\*\s*3600/);
});

test('el presupuesto por defecto de The Odds API respeta aproximadamente 500 créditos mensuales', () => {
  const source = fs.readFileSync(new URL('../lib/odds-api.js', import.meta.url), 'utf8');
  assert.match(source, /DEFAULT_DAILY_CREDIT_CAP = 16/);
  assert.match(source, /MULTISPORT_DAILY_RESERVE = 12/);
  assert.match(source, /bookmakers: 'bet365'/);
  assert.match(source, /h2h,spreads,totals/);
  assert.match(source, /Los vacíos también se cachean/);
});
