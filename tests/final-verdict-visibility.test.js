const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('fútbol exige el contrato íntegro v26 antes de servir recomendaciones', () => {
  const cache = read('lib/sanity-cache.js');
  assert.match(cache, /FOOTBALL_CACHE_VERSION = 26/);
  assert.match(cache, /MIN_CACHE_VERSION = 26/);
  assert.match(cache, /LEGACY_DISPLAY_MIN_VERSION = 24/);
  assert.match(cache, /strict \? MIN_CACHE_VERSION : LEGACY_DISPLAY_MIN_VERSION/);
});

test('las versiones nuevas no ocultan ni recalculan el análisis histórico', () => {
  const cache = read('lib/sanity-cache.js');
  const fixtures = read('app/api/fixtures/route.js');
  const engine = read('lib/api-football.js');
  assert.match(cache, /getAnalyzedFixtureIds\(date, \{ historical = false \} = \{\}\)/);
  assert.match(cache, /historical \? LEGACY_DISPLAY_MIN_VERSION : MIN_CACHE_VERSION/);
  assert.match(cache, /getAnalyzedMatchesFull\(fixtureIds, \{ historical = false \} = \{\}\)/);
  assert.match(fixtures, /getAnalyzedFixtureIds\(d, \{ historical: isPastDate \}\)/);
  assert.match(fixtures, /\{ historical: isPastDate \}/);
  assert.match(fixtures, /if \(!isPastDate && fixtures\.length > 0 && needsTrigger\)/);
  assert.match(cache, /preserveHistoricalCombinada/);
  assert.match(cache, /historicalSnapshot: true/);
  assert.match(engine, /kickoffMs <= Date\.now\(\)/);
  assert.match(engine, /getCachedAnalysis\(fixtureId, date, \{ historical: true \}\)/);
  assert.match(fixtures, /\.from\('combinada_dia'\)/);
  assert.match(fixtures, /historicalDailySelections/);
});

test('el arranque regenera hoy y mañana con v26 sin ascender una caché antigua', () => {
  const scheduler = read('apps/cfanalisis-worker/src/schedulers.ts');
  const batch = read('apps/cfanalisis-worker/src/jobs/futbol/analyze-batch.js');
  const odds = read('apps/cfanalisis-worker/src/jobs/futbol/odds.js');
  const lineups = read('apps/cfanalisis-worker/src/jobs/futbol/lineups.js');

  assert.match(scheduler, /dates\.slice\(0, 3\)/);
  assert.match(scheduler, /dates\.slice\(3\)/);
  assert.match(scheduler, /`futbol-analysis-v\$\{FOOTBALL_CACHE_VERSION\}-\$\{date\}`/);
  assert.match(scheduler, /'analysis-bootstrap'/);
  assert.match(batch, /Number\(cached\.cacheVersion \|\| 0\) >= FOOTBALL_CACHE_VERSION/);
  assert.match(odds, /getCachedAnalysis\(fixtureId, day\.date, \{ strict: true \}\)/);
  assert.match(lineups, /getCachedAnalysis\(fixtureId, today, \{ strict: true \}\)/);
});

test('el resumen de fútbol transporta el veredicto hasta la tarjeta', () => {
  const cache = read('lib/sanity-cache.js');
  const worker = read('apps/cfanalisis-worker/src/jobs/futbol/analyze-batch.js');
  assert.match(cache, /finalVerdict: doc\.finalVerdict \|\| null/);
  assert.match(worker, /finalVerdict: a\.finalVerdict \|\| null/);
  assert.match(worker, /verdictOnly/);
  assert.match(worker, /no modifica probabilidades, combinada ni motor/);
});

test('cada opción del veredicto identifica su porcentaje de probabilidad', () => {
  const panel = read('app/dashboard/components/FinalVerdictPanel.js');
  assert.match(panel, /<details className=\{`final-verdict-panel/);
  assert.match(panel, /<summary className="final-verdict-heading">/);
  assert.match(panel, /<small>Probabilidad<\/small>/);
  assert.match(panel, /rawProbability \?\? pick\.probability/);
  assert.match(panel, /El Veredicto final se está preparando/);
});

test('la tarjeta de béisbol conserva el veredicto y sus porcentajes', () => {
  const route = read('app/api/baseball/fixtures/route.js');
  const dashboard = read('app/dashboard/components/SharedSportAnalysis.js');
  assert.match(route, /finalVerdict: analysis\.analysis\?\.finalVerdict \|\| null/);
  assert.match(dashboard, /verdict=\{analysis\?\.analysis\?\.finalVerdict\}/);
});
