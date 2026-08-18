const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('las cuotas de fútbol se refrescan por fases desde API-Football y reconstruyen opciones', () => {
  const scheduler = fs.readFileSync(path.join(root, 'apps/cfanalisis-worker/src/schedulers.ts'), 'utf8');
  const job = fs.readFileSync(path.join(root, 'apps/cfanalisis-worker/src/jobs/futbol/odds.js'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'app/dashboard/page.js'), 'utf8');

  assert.match(scheduler, /id: 'futbol-api-odds-15m'.*pattern: '\*\/15 \* \* \* \*'/);
  assert.match(job, /timeUntilKickoffMs <= HOUR_MS.*'final'/);
  assert.match(job, /timeUntilKickoffMs <= 3 \* HOUR_MS.*'pregame'/);
  assert.match(job, /\/odds\?fixture=\$\{fixtureId\}/);
  assert.match(job, /extractOdds\(response\.response\)/);
  assert.match(job, /buildModelCombinada\(/);
  assert.match(job, /cacheAnalysis\(fixtureId, rebuilt\)/);
  assert.match(job, /'odds-ready'/);
  assert.doesNotMatch(job, /fetchOddsForFixtures|THE_ODDS_API_KEY/);
  assert.match(dashboard, /'odds-ready'/);
});
