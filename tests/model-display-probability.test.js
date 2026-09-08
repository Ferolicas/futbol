const test = require('node:test');
const assert = require('node:assert/strict');

const { displayPct, modelToScored, playerMarketsToSelections } = require('../lib/model-to-scored.js');
const { calculateGoalTimingProbabilities } = require('../lib/descriptive-stats.js');
const {
  FOOTBALL_DAILY_FRONTEND_MIN_PROBABILITY,
  isFootballFrontendDailyPickEligible,
  meetsFootballExpectedValuePolicy,
  meetsFootballReliability,
  requiredFootballExpectedValue,
  sanitizeFootballCombinada,
} = require('../lib/recommendation-policy.js');

let buildModelCombinada;
let buildCalculatedProbabilities;
let inspectMarketOdd;
test.before(async () => {
  ({ buildModelCombinada, buildCalculatedProbabilities, inspectMarketOdd } = await import('../lib/model-probabilities.js'));
});

const validatedFamily = (p, n = 500) => ({
  [p >= .95 ? 'elite95' : p >= .90 ? 'daily90' : p >= .80 ? 'high' : 'selectable70']: {
    n, avg_pred: p, avg_actual: p, gap: 0,
  },
});

test('el diagnóstico de cuota distingue oferta, mínimo, línea ausente y mercado sin adaptador', () => {
  const odds = {
    allBookmakerOdds: [{
      name: 'Bet365',
      corners: { Over_9: 1.5 },
      overUnder: { Over_0_5: 1.03 },
      homeSot: { Over_3_5: 1.8 },
      offsides: { Under_5_5: 1.72 },
    }],
  };

  assert.deepEqual(inspectMarketOdd('total_corners_over9_5', odds), {
    status: 'offered', field: 'corners', lineKey: 'Over_9_5',
    candidates: ['Over_9_5', 'Over_9'], odd: 1.5, bookmaker: 'Bet365',
  });
  assert.equal(inspectMarketOdd('total_goals_over0_5', odds).status, 'below_minimum');
  assert.equal(inspectMarketOdd('total_corners_over8_5', odds).status, 'line_not_offered');
  assert.equal(inspectMarketOdd('home_sot_over3_5', odds).odd, 1.8);
  assert.equal(inspectMarketOdd('total_offsides_under5_5', odds).odd, 1.72);
  assert.equal(inspectMarketOdd('first_goal_45', odds).status, 'unsupported_market');
});

test('la presentación limita a 95% sin alterar la frecuencia del motor', () => {
  assert.equal(displayPct(0), 0);
  assert.equal(displayPct(4.25), 4.25);
  assert.equal(displayPct(94.96), 94.96);
  assert.equal(displayPct(94.999), 94.99);
  assert.equal(displayPct(95), 95);
  assert.equal(displayPct(99.9), 95);
  assert.equal(displayPct(100), 95);
});

test('el EV no filtra por debajo de 90% y usa tramos 8/10 desde esa frontera', () => {
  assert.equal(requiredFootballExpectedValue(89.999), null);
  assert.equal(requiredFootballExpectedValue(90), 0.08);
  assert.equal(requiredFootballExpectedValue(90.999), 0.08);
  assert.equal(requiredFootballExpectedValue(91), 0.10);
  assert.equal(meetsFootballExpectedValuePolicy(80, -0.50), true);
  assert.equal(meetsFootballExpectedValuePolicy(null, 0.50), false);
  assert.equal(meetsFootballExpectedValuePolicy(101, 0.50), false);
  assert.equal(meetsFootballExpectedValuePolicy(90, 0.07999), false);
  assert.equal(meetsFootballExpectedValuePolicy(90, 0.08), true);
  assert.equal(meetsFootballExpectedValuePolicy(90.999, 0.09), true);
  assert.equal(meetsFootballExpectedValuePolicy(91, 0.09999), false);
  assert.equal(meetsFootballExpectedValuePolicy(91, 0.10), true);
});

test('la Apuesta del Día exige 90% calibrado, fiabilidad 90% y el tramo EV correspondiente', () => {
  assert.equal(FOOTBALL_DAILY_FRONTEND_MIN_PROBABILITY, 90);
  assert.equal(isFootballFrontendDailyPickEligible({
    rawProbability: 90, confidence: 90, odd: 1.20,
    expectedValue: .08, validationStatus: 'calibrated', dailyEligible: true,
  }), true);
  assert.equal(isFootballFrontendDailyPickEligible({
    rawProbability: 91, confidence: 90, odd: 1.20,
    expectedValue: .092, validationStatus: 'calibrated', dailyEligible: true,
  }), false);
  assert.equal(isFootballFrontendDailyPickEligible({
    rawProbability: 92, confidence: 90, odd: 1.20,
    expectedValue: .104, validationStatus: 'calibrated', dailyEligible: true,
  }), true);
  assert.equal(isFootballFrontendDailyPickEligible({
    rawProbability: 74.999, confidence: 99, odd: 2,
  }), false);
  assert.equal(isFootballFrontendDailyPickEligible({
    rawProbability: 95, confidence: 89.999, odd: 2,
  }), false);
  assert.equal(isFootballFrontendDailyPickEligible({
    rawProbability: 95, confidence: 99, odd: 1.19,
  }), false);
});

test('los mercados de jugador respetan el mismo contrato exacto', () => {
  const selections = playerMarketsToSelections({
    10: {
      player_id: 10,
      name: 'Jugador',
      markets: { anytime_scorer: { prob: 0.9496 } },
    },
  });
  assert.equal(selections[0].probability, 94.96);
  assert.equal(selections[0].rawProbability, 94.96);
});

test('la validación fuera de muestra calibra y autoriza solo con muestra suficiente', () => {
  const scored = modelToScored({
    goals_total: {
      kind: 'ou',
      lines: [{ line: 0.5, prob: 0.95, n: 2, hits: 2, level: 'empirical' }],
    },
  }, {
    calibrationFamilies: {
      goals_total_over_0_5: { elite95: { n: 100, avg_pred: 0.95, avg_actual: 0.9 } },
    },
    validationFamilies: {
      goals_total_over_0_5: { daily90: { n: 100, avg_pred: 0.925, avg_actual: 0.9, gap: 0.025 } },
    },
  });
  const result = scored.total_goals_over0_5;
  assert.equal(result.prob_raw, 0.95);
  assert.equal(result.prob_final, 0.925);
  assert.equal(result.recommended, true);
  assert.equal(result.validation.decision.status, 'calibrated');
  assert.equal(result.validation.n, 100);
  assert.equal(result.validation.calibration.band, 'elite95');
});

test('la falta de diagnóstico conserva la estadística pero bloquea la recomendación', () => {
  const scored = modelToScored({
    goals_total: {
      kind: 'ou',
      lines: [{ line: 0.5, prob: 0.98, n: 2, hits: 2, level: 'empirical' }],
    },
  });
  assert.equal(scored.total_goals_over0_5.prob_final, 0.98);
  assert.equal(scored.total_goals_over0_5.recommended, false);
  assert.equal(scored.total_goals_over0_5.validation.available, false);
  assert.equal(scored.total_goals_over0_5.validation.decision.status, 'unvalidated');
});

test('una sola observación puede producir 100% interno y mostrar 95%', () => {
  const scored = modelToScored({
    corners_total: {
      kind: 'ou',
      lines: [{ line: 0.5, prob: 1, n: 1, hits: 1, level: 'empirical' }],
    },
  });
  assert.equal(scored.total_corners_over0_5.prob_final, 1);
  assert.equal(displayPct(scored.total_corners_over0_5.prob_final * 100), 95);
  assert.equal(scored.total_corners_over0_5.recommended, false);
});

test('over y under conservan la fiabilidad de su dirección exacta', () => {
  const scored = modelToScored({
    corners_total: {
      kind: 'ou',
      lines: [{ line: 8.5, prob: 0.1, n: 100, hits: 10, conf: 0.01, underConf: 0.98, level: 'empirical' }],
    },
    btts: { kind: 'bool', prob: 0.2, n: 100, hits: 20, conf: 0.02, inverseConf: 0.97, level: 'empirical' },
  });
  assert.equal(scored.total_corners_over8_5.confidence, 0.01);
  assert.equal(scored.total_corners_under8_5.confidence, 0.98);
  assert.equal(scored.btts.confidence, 0.02);
  assert.equal(scored.btts_no.confidence, 0.97);
});

test('el catálogo usa la probabilidad calibrada y no inventa una combinada del mismo partido', () => {
  const scored = modelToScored({
    goals_total: {
      kind: 'ou',
      lines: [{ line: 0.5, prob: 0.9975, n: 120, hits: 120, conf: 0.95, level: 'empirical' }],
    },
  }, { validationFamilies: { goals_total_over_0_5: validatedFamily(.9975) } });
  const result = buildModelCombinada(
    scored,
    { overUnder: { Over_0_5: 1.5 } },
    { home: 'Local', away: 'Visitante' },
    {},
    {},
    null,
  );
  assert.equal(result.selections[0].probability, 95);
  assert.equal(result.selections[0].rawProbability, 99.75);
  assert.equal(result.combinedProbability, null);
  assert.equal(result.correlationStatus, 'same-fixture-not-priced');
});

test('una opción calibrada inferior a 90% conserva su EV como dato pero no se filtra por él', () => {
  const scored = modelToScored({
    goals_total: {
      kind: 'ou',
      lines: [{ line: 2.5, prob: 0.8, n: 500, hits: 400, conf: 0.95, level: 'empirical' }],
    },
  }, { validationFamilies: { goals_total_over_2_5: validatedFamily(.8) } });
  const result = buildModelCombinada(
    scored,
    { overUnder: { Over_2_5: 1.20 } },
    { home: 'Local', away: 'Visitante' },
    {},
    {},
    null,
  );
  assert.equal(result.selections.length, 1);
  assert.equal(result.selectable.length, 1);
  assert.ok(result.selectable[0].expectedValue < 0);
  assert.equal(result.selectable[0].dailyEligible, false);
});

test('80% requiere además calibración de su familia', () => {
  const scored = modelToScored({
    goals_total: {
      kind: 'ou',
      lines: [
        { line: 1.5, prob: 0.8, n: 5, hits: 4, level: 'empirical' },
        { line: 2.5, prob: 0.7999, n: 5, hits: 4, level: 'empirical' },
      ],
    },
  }, { validationFamilies: {
    goals_total_over_1_5: validatedFamily(.8),
    goals_total_over_2_5: validatedFamily(.7999),
  } });
  assert.equal(scored.total_goals_over1_5.recommended, true);
  assert.equal(scored.total_goals_over2_5.recommended, false);
});

test('una familia descalibrada queda fuera de recomendación y Apuesta del Día', () => {
  const scored = modelToScored({
    goals_total: {
      kind: 'ou',
      lines: [{ line: 1.5, prob: 0.9, n: 108, hits: 97, conf: 0.9, level: 'empirical' }],
    },
  }, {
    validationFamilies: {
      goals_total_over_1_5: { daily90: { n: 20, avg_pred: 0.9, avg_actual: 0.7 } },
    },
  });
  const result = buildModelCombinada(
    scored,
    { overUnder: { Over_1_5: 1.6 } },
    { home: 'Local', away: 'Visitante' },
    {},
    {},
    null,
  );
  assert.equal(result.selections.length, 0);
  assert.equal(result.selectable.length, 0);
});

test('un prop de jugador entra cuando su fiabilidad real llega al 90%', () => {
  const result = buildModelCombinada(
    {},
    {
      allBookmakerOdds: [{
        name: 'bet365',
        players: { scorer: { jugador: 1.65 } },
      }],
    },
    { home: 'Local', away: 'Visitante' },
    {
      10: {
        player_id: 10,
        name: 'Jugador',
        markets: { anytime_scorer: { prob: 0.9, n: 72, conf: 0.9, validation: {
          available: true, n: 500, avgPred: .9, avgActual: .9,
        } } },
      },
    },
    {},
    null,
  );
  assert.equal(result.selections.length, 1);
  assert.equal(result.selections[0].scope, 'player');
  assert.equal(result.selections[0].probability, 90);
  assert.equal(result.selections[0].dailyEligible, true);
  assert.equal(result.selections[0].confidence, 90);
});

test('fiabilidad 90 filtra solo opciones de apuesta y conserva todas las frecuencias calculadas', () => {
  const scored = modelToScored({
    goals_total: {
      kind: 'ou',
      lines: [
        { line: 0.5, prob: 0.7, n: 108, hits: 76, conf: 0.9, level: 'empirical' },
        { line: 1.5, prob: 0.8, n: 108, hits: 86, conf: 0.9, level: 'empirical' },
        { line: 2.5, prob: 0.95, n: 107, hits: 102, conf: 0.899999, level: 'empirical' },
      ],
    },
  }, { validationFamilies: {
    goals_total_over_0_5: validatedFamily(.7),
    goals_total_over_1_5: validatedFamily(.8),
    goals_total_over_2_5: validatedFamily(.95),
  } });
  const descriptives = {
    homeAvg: { n: 8, goalsFor: 1.2, goalsAgainst: 1.1, coverage: {} },
    awayAvg: { n: 9, goalsFor: 1.3, goalsAgainst: 1.0, coverage: {} },
    meetings: 0,
    dataAvailability: {},
  };
  const probabilities = buildCalculatedProbabilities(scored, descriptives, {});
  const result = buildModelCombinada(
    scored,
    { overUnder: { Over_0_5: 2, Over_1_5: 1.5, Over_2_5: 1.9 } },
    { home: 'Local', away: 'Visitante' },
    {},
    probabilities,
    null,
  );

  assert.equal(probabilities.overUnder.over15, 80);
  assert.equal(probabilities.overUnder.over25, 95);
  assert.deepEqual(result.selectable.map((selection) => selection.id).sort(), [
    'total_goals_over0_5',
    'total_goals_over1_5',
  ]);
  assert.deepEqual(result.selections.map((selection) => selection.id), ['total_goals_over1_5']);
  assert.equal(result.selectable.some((selection) => selection.id === 'total_goals_over2_5'), false);
  assert.equal(result.minimumReliability, 90);
  assert.equal(result._funnel.bajoFiabilidad90, 1);
});

test('un prop de jugador bajo 90% de fiabilidad no se publica aunque tenga probabilidad y cuota', () => {
  const result = buildModelCombinada(
    {},
    {
      allBookmakerOdds: [{
        name: 'bet365',
        players: { scorer: { fiable: 1.65, insuficiente: 1.70 } },
      }],
    },
    { home: 'Local', away: 'Visitante' },
    {
      10: {
        player_id: 10,
        name: 'Fiable',
        markets: { anytime_scorer: { prob: 0.9, n: 72, conf: 0.9, validation: {
          available: true, n: 500, avgPred: .9, avgActual: .9,
        } } },
      },
      11: {
        player_id: 11,
        name: 'Insuficiente',
        markets: { anytime_scorer: { prob: 0.95, n: 71, conf: 0.899999, validation: {
          available: true, n: 500, avgPred: .95, avgActual: .95,
        } } },
      },
    },
    {},
    null,
  );

  assert.deepEqual(result.selectable.map((selection) => selection.playerId), [10]);
  assert.equal(result._funnel.playerBelowReliability, 1);
});

test('la frontera pública rechaza caches sin fiabilidad y nunca redondea 89.999 a 90', () => {
  assert.equal(meetsFootballReliability(0.9), true);
  assert.equal(meetsFootballReliability(89.999), false);
  const sanitized = sanitizeFootballCombinada({
    source: 'context-engine',
    selections: [
      { id: 'ok', confidence: 90, odd: 1.5, rawProbability: 80, expectedValue: .2, validationStatus: 'calibrated' },
      { id: 'low', confidence: 89.999, odd: 1.8, rawProbability: 95 },
      { id: 'legacy', odd: 1.9, rawProbability: 95 },
    ],
    selectable: [
      { id: 'ok', confidence: 90, odd: 1.5, rawProbability: 80, expectedValue: .2, validationStatus: 'calibrated' },
      { id: 'quality-not-price', confidence: 94, odd: 1.2, rawProbability: 82, expectedValue: -.016, validationStatus: 'calibrated' },
      { id: 'missing-ev', confidence: 94, odd: 1.4, rawProbability: 82, expectedValue: null, validationStatus: 'calibrated' },
      { id: 'legacy', odd: 1.9, rawProbability: 95 },
    ],
  });

  assert.deepEqual(sanitized.selections.map((selection) => selection.id), ['ok']);
  assert.deepEqual(sanitized.selectable.map((selection) => selection.id), ['ok', 'quality-not-price']);
  assert.equal(sanitized.combinedProbability, null);
  assert.equal(sanitized.combinedOdd, null);

  const compatibleV20 = sanitizeFootballCombinada({
      source: 'context-engine',
      selections: [
        { id: 'reliable-v20', confidence: 91, odd: 1.4, rawProbability: 82, expectedValue: .14, validationStatus: 'calibrated' },
        { id: 'low-v20', confidence: 89, odd: 1.5, rawProbability: 90 },
      ],
      selectable: [
        { id: 'legacy-without-confidence', odd: 1.3, rawProbability: 75, expectedValue: .12 },
        { id: 'legacy-unknown', odd: 1.4, rawProbability: 95 },
      ],
    }, {
      'legacy-without-confidence': { confidence: 0.92, n: 46, validation: { decision: { status: 'calibrated' } } },
    });
  assert.deepEqual(compatibleV20.selections.map((selection) => selection.id), ['reliable-v20']);
  assert.deepEqual(compatibleV20.selectable.map((selection) => selection.id), ['legacy-without-confidence', 'reliable-v20']);
  assert.equal(compatibleV20.selectable[0].confidence, 92);
  assert.equal(compatibleV20.selectable[0].sampleN, 46);
});

test('los tramos de gol cuentan partidos con ocurrencia y no cantidad de goles', () => {
  const timing = calculateGoalTimingProbabilities({
    home: {
      totalMatches: 2,
      periods: { '0-15': { scored: 3, conceded: 0, matchesWithGoal: 1 } },
    },
    away: {
      totalMatches: 2,
      periods: { '0-15': { scored: 1, conceded: 1, matchesWithGoal: 2 } },
    },
  });
  assert.equal(timing.home[0].probability, 50);
  assert.equal(timing.away[0].probability, 100);
  assert.equal(timing.combined[0].probability, 75);
});
