const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('el resumen de fútbol usa pestañas accesibles en lugar de subacordeones', () => {
  const dashboard = read('app/dashboard/page.js');
  assert.match(dashboard, /role=\{isTabs \? 'tablist'/);
  assert.match(dashboard, /role="tabpanel"/);
  assert.match(dashboard, /label: 'Mercados para tu combinada'/);
  assert.match(dashboard, /label: 'Estadísticas calculadas'/);
  assert.match(dashboard, /label: 'Frecuencias calculadas'/);
  assert.match(dashboard, /label: 'Jugadores destacados'/);
  assert.match(dashboard, /label: 'Veredicto final'/);
  assert.doesNotMatch(dashboard, /function SubAccordion/);
});

test('las subcategorías son filtros horizontales y Goles aparece primero', () => {
  const dashboard = read('app/dashboard/page.js');
  const styles = read('app/globals.css');
  assert.match(dashboard, /useState\('goals'\)/);
  assert.match(dashboard, /useState\('goles'\)/);
  assert.match(dashboard, /variant="filters"/);
  assert.match(styles, /\.analysis-choice-scroll[\s\S]*overflow-x: auto/);
  assert.match(styles, /touch-action: pan-x/);
});

test('Veredicto final puede integrarse abierto dentro de su pestaña', () => {
  const dashboard = read('app/dashboard/page.js');
  const panel = read('app/dashboard/components/FinalVerdictPanel.js');
  assert.match(dashboard, /<FinalVerdictPanel[\s\S]*compact[\s\S]*embedded/);
  assert.match(panel, /if \(embedded\)/);
  assert.match(panel, /final-verdict-panel is-embedded/);
});
