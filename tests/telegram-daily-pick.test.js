const test = require('node:test');
const assert = require('node:assert/strict');

let dailyPickModule;
test.before(async () => {
  dailyPickModule = await import('../lib/telegram-daily-pick.js');
});

// Opción válida por defecto: 90% de probabilidad, 95% de fiabilidad, cuota 1.55.
const option = (overrides = {}) => ({
  fixtureId: 1,
  matchName: 'Local vs Visitante',
  id: 'total_goals_over1_5',
  name: 'Más de 1.5 goles',
  probability: 90,
  confidence: 95,
  odd: 1.55,
  ...overrides,
});

// Tres opciones válidas y distintas para un mismo partido.
const matchOptions = (fixtureId, overrides = {}) => [
  option({ fixtureId, id: `goals-${fixtureId}`, name: 'Más de 1.5 goles', ...overrides }),
  option({ fixtureId, id: `corners-${fixtureId}`, name: 'Más de 7.5 córners', ...overrides }),
  option({ fixtureId, id: `cards-${fixtureId}`, name: 'Más de 2.5 tarjetas', ...overrides }),
];

test('Telegram publica un partido con sus tres opciones', () => {
  const result = dailyPickModule.selectTelegramDailyPick(matchOptions(1));
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].fixtureId, 1);
  assert.equal(result.matches[0].options.length, 3);
});

test('Telegram publica partidos con una o dos opciones válidas', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    option({ fixtureId: 1, id: 'goals-1' }),
    option({ fixtureId: 1, id: 'corners-1', name: 'Más de 7.5 córners' }),
    option({ fixtureId: 2, id: 'goals-2', matchName: 'Otro vs Rival' }),
  ]);
  assert.equal(result.matches.length, 2);
  assert.deepEqual(result.matches.map(match => match.options.length), [2, 1]);
  assert.equal(result.eligibleCount, 3);
  assert.equal(result.eligibleMatchCount, 2);
});

test('Telegram publica los diez partidos si cada uno tiene una opción válida', () => {
  const selections = Array.from({ length: 10 }, (_, index) => option({
    fixtureId: index + 1,
    matchName: `Local ${index + 1} vs Visitante ${index + 1}`,
    id: `goals-${index + 1}`,
  }));
  const result = dailyPickModule.selectTelegramDailyPick(selections);
  assert.equal(result.matches.length, 10);
  assert.equal(result.eligibleMatchCount, 10);
  assert.ok(result.matches.every(match => match.options.length === 1));
});

test('Telegram publica dos partidos si solo hay dos, y uno si solo hay uno', () => {
  const dos = dailyPickModule.selectTelegramDailyPick([...matchOptions(1), ...matchOptions(2)]);
  assert.equal(dos.matches.length, 2);

  const uno = dailyPickModule.selectTelegramDailyPick(matchOptions(7));
  assert.equal(uno.matches.length, 1);
});

test('Telegram exige probabilidad desde 85% y fiabilidad desde 90%', () => {
  const bajaProbabilidad = dailyPickModule.selectTelegramDailyPick([
    ...matchOptions(1, { probability: 84.99 }),
  ]);
  assert.equal(bajaProbabilidad.matches.length, 0);

  const bajaFiabilidad = dailyPickModule.selectTelegramDailyPick([
    ...matchOptions(1, { confidence: 89.99 }),
  ]);
  assert.equal(bajaFiabilidad.matches.length, 0);

  const justo = dailyPickModule.selectTelegramDailyPick([
    ...matchOptions(1, { probability: 85, confidence: 90 }),
  ]);
  assert.equal(justo.matches.length, 1);
});

test('Telegram filtra por cuota mínima 1.20 pero no tiene techo', () => {
  const bajoMinimo = dailyPickModule.selectTelegramDailyPick(matchOptions(1, { odd: 1.19 }));
  assert.equal(bajoMinimo.matches.length, 0);

  const cuotaAlta = dailyPickModule.selectTelegramDailyPick(matchOptions(1, { odd: 3.4 }));
  assert.equal(cuotaAlta.matches.length, 1);
  assert.equal(cuotaAlta.matches[0].options[0].odd, 3.4);
});

test('la cuota no ordena: gana la de mayor fiabilidad a igual probabilidad', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    option({ fixtureId: 1, id: 'a', name: 'Más de 1.5 goles', probability: 90, confidence: 96, odd: 1.6 }),
    option({ fixtureId: 1, id: 'b', name: 'Más de 7.5 córners', probability: 90, confidence: 90, odd: 1.2 }),
    option({ fixtureId: 1, id: 'c', name: 'Más de 2.5 tarjetas', probability: 90, confidence: 93, odd: 1.35 }),
  ]);
  assert.deepEqual(result.matches[0].options.map(item => item.id), ['a', 'c', 'b']);
});

test('la probabilidad manda por encima de la fiabilidad', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    option({ fixtureId: 1, id: 'a', name: 'Más de 1.5 goles', probability: 88, confidence: 99 }),
    option({ fixtureId: 1, id: 'b', name: 'Más de 7.5 córners', probability: 92, confidence: 90 }),
    option({ fixtureId: 1, id: 'c', name: 'Más de 2.5 tarjetas', probability: 90, confidence: 90 }),
  ]);
  assert.deepEqual(result.matches[0].options.map(item => item.id), ['b', 'c', 'a']);
});

test('Telegram se queda con las tres mejores opciones del partido', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    option({ fixtureId: 1, id: 'a', name: 'Más de 1.5 goles', probability: 94 }),
    option({ fixtureId: 1, id: 'b', name: 'Más de 7.5 córners', probability: 93 }),
    option({ fixtureId: 1, id: 'c', name: 'Más de 2.5 tarjetas', probability: 92 }),
    option({ fixtureId: 1, id: 'd', name: 'Más de 4.5 remates a puerta', probability: 86 }),
  ]);
  assert.equal(result.matches[0].options.length, 3);
  assert.deepEqual(result.matches[0].options.map(item => item.id), ['a', 'b', 'c']);
});

test('los partidos se ordenan por probabilidad media y luego fiabilidad media', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    ...matchOptions(1, { probability: 88, confidence: 92 }),
    ...matchOptions(2, { probability: 93, confidence: 91 }),
    ...matchOptions(3, { probability: 88, confidence: 97 }),
  ]);
  assert.deepEqual(result.matches.map(item => item.fixtureId), [2, 3, 1]);
});

test('Telegram sigue vetando mercados no comerciales', () => {
  const result = dailyPickModule.selectTelegramDailyPick([
    option({ fixtureId: 1, id: 'ah_home_m0_5', name: 'Hándicap local' }),
    option({ fixtureId: 1, id: 'winner-home', name: 'Ganador local' }),
    option({ fixtureId: 1, id: 'btts', name: 'Ambos marcan' }),
  ]);
  assert.equal(result.matches.length, 0);
  assert.equal(result.eligibleCount, 0);
});

test('Telegram usa la frecuencia cruda y muestra máximo 95%', () => {
  const result = dailyPickModule.selectTelegramDailyPick(
    matchOptions(1, { probability: 99.75, rawProbability: 99.75 }),
  );
  assert.equal(result.matches[0].options[0].probability, 95);
  assert.equal(result.matches[0].options[0].rawProbability, 99.75);
  assert.equal(result.matches[0].averageProbability, 95);
});

test('el contrato Telegram expone todos sus límites operativos', () => {
  assert.deepEqual(dailyPickModule.TELEGRAM_DAILY_PICK_RULES, {
    minProbability: 85,
    minReliability: 90,
    minSelectionOdd: 1.2,
    minOptionsPerMatch: 1,
    maxOptionsPerMatch: 3,
    maxMatches: null,
  });
});
