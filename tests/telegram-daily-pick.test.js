const test = require('node:test');
const assert = require('node:assert/strict');

let dailyPickModule;
test.before(async () => {
  dailyPickModule = await import('../lib/telegram-daily-pick.js');
});

const selection = (overrides = {}) => ({
  fixtureId: 1,
  id: 'total_goals_over1_5',
  name: 'Más de 1.5 goles',
  probability: 90,
  confidence: 95,
  odd: 1.55,
  ...overrides,
});

test('Telegram publica una sola opción entre cuota 1.50 y 1.60', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    selection(),
    selection({ fixtureId: 2, id: 'winner-home', name: 'Ganador local', probability: 95 }),
  ]);
  assert.equal(result.selections.length, 1);
  assert.equal(result.selections[0].fixtureId, 1);
  assert.equal(result.combinedOdd, 1.55);
});

test('Telegram combina partidos distintos hasta cuota 2.00 con probabilidad conjunta de 80%', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    selection({ fixtureId: 1, id: 'total_corners_over7_5', name: 'Más de 7.5 córners', probability: 95, confidence: 92, odd: 1.23 }),
    selection({ fixtureId: 2, id: 'total_sot_over4_5', name: 'Más de 4.5 remates a puerta', probability: 96, confidence: 94, odd: 1.25 }),
    selection({ fixtureId: 3, id: 'total_cards_over2_5', name: 'Más de 2.5 tarjetas', probability: 79.9, odd: 1.55 }),
    selection({ fixtureId: 4, id: 'ah_home_m0_5', name: 'Hándicap local', probability: 95, odd: 1.55 }),
  ]);
  assert.deepEqual(result.selections.map((item) => item.fixtureId).sort(), [1, 2]);
  assert.equal(result.combinedOdd, 1.54);
  assert.ok(result.rawCombinedProbability >= 80);
});

test('Telegram rechaza una combinación cuya probabilidad conjunta baja de 80%', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    selection({ fixtureId: 1, id: 'total_corners_over7_5', name: 'Más de 7.5 córners', probability: 89, odd: 1.25 }),
    selection({ fixtureId: 2, id: 'total_sot_over4_5', name: 'Más de 4.5 remates a puerta', probability: 89, odd: 1.25 }),
  ]);
  assert.equal(result.selections.length, 0);
  assert.equal(result.eligibleCount, 2);
});

test('Telegram exige fiabilidad individual mínima de 80%', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    selection({ fixtureId: 1, probability: 99, confidence: 79.99 }),
    selection({ fixtureId: 2, probability: 88, confidence: 0.80 }),
  ]);
  assert.equal(result.selections.length, 1);
  assert.equal(result.selections[0].fixtureId, 2);
  assert.equal(result.selections[0].confidence, 80);
});

test('Telegram prioriza probabilidad y después fiabilidad, antes que cuota', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    selection({ fixtureId: 1, probability: 91, confidence: 90, odd: 1.60 }),
    selection({ fixtureId: 2, probability: 92, confidence: 80, odd: 1.50 }),
    selection({ fixtureId: 3, probability: 92, confidence: 96, odd: 1.51 }),
  ]);
  assert.equal(result.selections.length, 1);
  assert.equal(result.selections[0].fixtureId, 3);
});

test('Telegram nunca acepta una cuota individual superior a 1.60', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    selection({ fixtureId: 1, probability: 99, confidence: 99, odd: 1.61 }),
    selection({ fixtureId: 2, probability: 88, confidence: 95, odd: 1.55 }),
  ]);
  assert.equal(result.selections.length, 1);
  assert.equal(result.selections[0].fixtureId, 2);
});

test('Telegram no combina dos selecciones del mismo partido', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    selection({ fixtureId: 1, id: 'total_goals_over0_5', name: 'Más de 0.5 goles', probability: 95, odd: 1.25 }),
    selection({ fixtureId: 1, id: 'total_corners_over5_5', name: 'Más de 5.5 córners', probability: 95, odd: 1.25 }),
  ]);
  assert.equal(result.selections.length, 0);
});

test('Telegram elige con la frecuencia cruda y muestra máximo 95%', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    selection({ probability: 99.75, rawProbability: 99.75 }),
  ]);
  assert.equal(result.selections[0].probability, 95);
  assert.equal(result.selections[0].rawProbability, 99.75);
  assert.equal(result.combinedProbability, 95);
  assert.equal(result.rawCombinedProbability, 99.75);
});

test('el contrato Telegram expone todos sus límites operativos', () => {
  assert.deepEqual(dailyPickModule.TELEGRAM_DAILY_PICK_RULES, {
    minProbability: 80,
    minReliability: 80,
    minSelectionOdd: 1.2,
    maxSelectionOdd: 1.6,
    minCombinedOdd: 1.5,
    maxCombinedOdd: 2,
    minCombinedProbability: 80,
    maxLegs: 3,
  });
});
