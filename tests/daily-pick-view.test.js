const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDailyPickView } = require('../lib/daily-pick-view.js');

test('mantiene próximas mientras todavía no existe ningún resultado', () => {
  assert.equal(resolveDailyPickView('results', 3, 0), 'picks');
});

test('respeta la vista elegida cuando hay próximas y resultados', () => {
  assert.equal(resolveDailyPickView('picks', 2, 1), 'picks');
  assert.equal(resolveDailyPickView('results', 2, 1), 'results');
});

test('activa resultados cuando ya no queda ninguna apuesta próxima', () => {
  assert.equal(resolveDailyPickView('picks', 0, 4), 'results');
});

test('una jornada sin opciones conserva la vista de próximas', () => {
  assert.equal(resolveDailyPickView('results', 0, 0), 'picks');
});
