const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('fútbol conserva análisis v23 al añadir el veredicto v24', () => {
  const cache = read('lib/sanity-cache.js');
  assert.match(cache, /FOOTBALL_CACHE_VERSION = 24/);
  assert.match(cache, /MIN_CACHE_VERSION = 23/);
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
  const dashboard = read('app/dashboard/baseball/page.js');
  assert.match(route, /finalVerdict: analysis\.analysis\?\.finalVerdict \|\| null/);
  assert.match(dashboard, /verdict=\{game\.analysis\?\.analysis\?\.finalVerdict\}/);
});
