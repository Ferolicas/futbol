const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  HOUR_MS,
  scanDates,
  hasUsableOdds,
  catalogSize,
  refreshIntervalMs,
  shouldAttempt,
} = require('../apps/cfanalisis-worker/src/jobs/futbol/odds-policy.cjs');

const root = path.join(__dirname, '..');

test('las cuotas de fútbol se vigilan hasta el kickoff y reconstruyen opciones', () => {
  const scheduler = fs.readFileSync(path.join(root, 'apps/cfanalisis-worker/src/schedulers.ts'), 'utf8');
  const job = fs.readFileSync(path.join(root, 'apps/cfanalisis-worker/src/jobs/futbol/odds.js'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'app/dashboard/page.js'), 'utf8');

  assert.match(scheduler, /id: 'futbol-api-odds-15m'.*pattern: '\*\/15 \* \* \* \*'/);
  assert.match(job, /scanDates\(bogotaToday\(\), payload\.date\)/);
  assert.match(job, /getCachedFixturesRaw\(date\)/);
  assert.match(job, /football-odds-refresh-v2/);
  assert.doesNotMatch(job, /MAX_EMPTY_ATTEMPTS|complete: true, hasOdds: false/);
  assert.match(job, /\/odds\?fixture=\$\{fixtureId\}/);
  assert.match(job, /extractOdds\(response\.response\)/);
  assert.match(job, /buildModelCombinada\(/);
  assert.match(job, /cacheAnalysis\(fixtureId, rebuilt\)/);
  assert.match(job, /'odds-ready'/);
  assert.doesNotMatch(job, /fetchOddsForFixtures|THE_ODDS_API_KEY/);
  assert.match(dashboard, /'odds-ready'/);
});

test('la vigilancia cubre días adyacentes y nunca consulta tras el kickoff', () => {
  assert.deepEqual(scanDates('2026-08-18'), ['2026-08-18', '2026-08-19', '2026-08-17']);
  assert.deepEqual(scanDates('2026-08-18', '2026-08-21'), ['2026-08-21']);
  assert.equal(refreshIntervalMs(0, false), null);
  assert.equal(refreshIntervalMs(-1, false), null);
  assert.equal(refreshIntervalMs(37 * HOUR_MS, false), null);
});

test('una respuesta vacía sigue reintentándose hasta el inicio', () => {
  assert.equal(refreshIntervalMs(20 * HOUR_MS, false), HOUR_MS);
  assert.equal(refreshIntervalMs(8 * HOUR_MS, false), 30 * 60_000);
  assert.equal(refreshIntervalMs(2 * HOUR_MS, false), 15 * 60_000);
  assert.equal(refreshIntervalMs(30 * 60_000, false), 15 * 60_000);
  assert.equal(shouldAttempt(null, Date.parse('2026-08-18T10:00:00Z'), 15 * 60_000), true);
  assert.equal(shouldAttempt(
    { lastAttemptAt: '2026-08-18T09:50:00Z' },
    Date.parse('2026-08-18T10:00:00Z'),
    15 * 60_000,
  ), false);
  assert.equal(shouldAttempt(
    { lastAttemptAt: '2026-08-18T09:45:00Z' },
    Date.parse('2026-08-18T10:00:00Z'),
    15 * 60_000,
  ), true);
});

test('un catálogo existente también se refresca más rápido cerca del partido', () => {
  assert.equal(refreshIntervalMs(20 * HOUR_MS, true), 6 * HOUR_MS);
  assert.equal(refreshIntervalMs(8 * HOUR_MS, true), 3 * HOUR_MS);
  assert.equal(refreshIntervalMs(2 * HOUR_MS, true), 30 * 60_000);
  assert.equal(refreshIntervalMs(45 * 60_000, true), 15 * 60_000);
});

test('detecta únicamente catálogos con cuotas reales', () => {
  assert.equal(hasUsableOdds(null), false);
  assert.equal(hasUsableOdds({ bookmaker: 'Bet365', allowedOnly: true }), false);
  const odds = {
    bookmaker: 'Bet365',
    allBookmakerOdds: [{ id: 8, name: 'Bet365', overUnder: { Over_2_5: 1.85, Under_2_5: 1.95 } }],
  };
  assert.equal(hasUsableOdds(odds), true);
  assert.equal(catalogSize(odds), 2);
});
