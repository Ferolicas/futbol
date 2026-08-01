const test = require('node:test');
const assert = require('node:assert/strict');

let dailyPickModule;
test.before(async () => {
  dailyPickModule = await import('../lib/telegram-daily-pick.js');
});

test('Telegram publica una sola opción válida cuando ya alcanza cuota 1.50–2.00', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    { fixtureId: 1, id: 'total_goals_over1_5', name: 'Más de 1.5 goles', probability: 95, odd: 1.72, dailyValidated: true },
    { fixtureId: 2, id: 'winner-home', name: 'Ganador local', probability: 95, odd: 1.8, dailyValidated: true },
  ]);
  assert.equal(result.selections.length, 1);
  assert.equal(result.selections[0].fixtureId, 1);
  assert.equal(result.combinedOdd, 1.72);
});

test('Telegram combina el mínimo de partidos distintos y nunca usa hándicap ni menos de 95%', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    { fixtureId: 1, id: 'total_corners_over7_5', name: 'Más de 7.5 córners', probability: 95, odd: 1.23, dailyValidated: true },
    { fixtureId: 2, id: 'total_sot_over4_5', name: 'Más de 4.5 remates a puerta', probability: 96, odd: 1.25, dailyValidated: true },
    { fixtureId: 3, id: 'total_cards_over2_5', name: 'Más de 2.5 tarjetas', probability: 94, odd: 1.8, dailyValidated: true },
    { fixtureId: 4, id: 'ah_home_m0_5', name: 'Hándicap local', probability: 95, odd: 1.8, dailyValidated: true },
  ]);
  assert.deepEqual(result.selections.map((item) => item.fixtureId).sort(), [1, 2]);
  assert.equal(result.combinedOdd, 1.54);
});

test('Telegram no combina dos selecciones del mismo partido', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    { fixtureId: 1, id: 'total_goals_over0_5', name: 'Más de 0.5 goles', probability: 95, odd: 1.25, dailyValidated: true },
    { fixtureId: 1, id: 'total_corners_over5_5', name: 'Más de 5.5 córners', probability: 95, odd: 1.25, dailyValidated: true },
  ]);
  assert.equal(result.selections.length, 0);
});

test('Telegram rechaza un 95% cuya familia no sostuvo 95% fuera de muestra', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    { fixtureId: 1, id: 'total_goals_over1_5', name: 'Más de 1.5 goles', probability: 95, odd: 1.7, dailyValidated: false },
  ]);
  assert.equal(result.selections.length, 0);
  assert.equal(result.eligibleCount, 0);
});
