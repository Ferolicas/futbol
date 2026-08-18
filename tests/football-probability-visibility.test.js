const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('las frecuencias over/under se muestran aunque la cuota siga pendiente', async () => {
  const { probabilityLineItems } = await import('../app/dashboard/utils/probability-lines.js');
  const items = probabilityLineItems({
    _lines: [0.5, 1.5],
    over0_5: 90.77,
    under0_5: 9.22,
    over1_5: 54.95,
    under1_5: 45.04,
  }, null);

  assert.deepEqual(items, [
    { label: 'Más de 0.5', value: 90.77, odd: null },
    { label: 'Menos de 0.5', value: 9.22, odd: null },
    { label: 'Más de 1.5', value: 54.95, odd: null },
    { label: 'Menos de 1.5', value: 45.04, odd: null },
  ]);
});

test('la cuota exacta se adjunta sin controlar la existencia de la probabilidad', async () => {
  const { probabilityLineItems } = await import('../app/dashboard/utils/probability-lines.js');
  const items = probabilityLineItems(
    { _lines: [2.5], over2_5: 77.13, under2_5: 22.87 },
    { Over_2_5: 1.25, Under_2_5: 3.75 },
  );
  assert.deepEqual(items, [
    { label: 'Más de 2.5', value: 77.13, odd: 1.25 },
    { label: 'Menos de 2.5', value: 22.87, odd: 3.75 },
  ]);
});

test('dashboard y análisis completo no ocultan frecuencias por falta de cuota', () => {
  const dashboard = fs.readFileSync(path.join(root, 'app/dashboard/page.js'), 'utf8');
  const detail = fs.readFileSync(path.join(root, 'app/dashboard/analisis/[id]/page.js'), 'utf8');
  assert.match(dashboard, /buildFootballProbabilityGroups\(p, odds, homeTeam, awayTeam\)/);
  assert.match(dashboard, /'Cuota pendiente'/);
  assert.match(detail, /const cats = buildFootballProbabilityGroups\(p, o, a\.homeTeam, a\.awayTeam\)/);
});
