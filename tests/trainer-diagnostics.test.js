const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateConfig,
  upsertDiagnostics,
} = require('../scripts/train-football-empirical-engine.js');
const {
  DEFAULT_ENGINE_CONFIG,
  normalizeEngineConfig,
} = require('../lib/model-engine.js');

test('la validación incremental conserva calibración train→validation sin retener observaciones', async () => {
  const markets = (probability) => ({
    goals_total: {
      kind: 'ou',
      lines: [{ line: 0.5, prob: probability }],
    },
  });
  const sample = (probability, homeGoals) => ({
    ctx: {},
    actual: { ft_home: homeGoals, ft_away: 0 },
    earlyRawRows: {},
    earlyBaselineMarkets: markets(probability),
    probableRawRows: null,
    probableBaselineMarkets: null,
    confirmedRawRows: null,
    confirmedBaselineMarkets: null,
  });
  const config = normalizeEngineConfig(DEFAULT_ENGINE_CONFIG);
  const result = await evaluateConfig([
    sample(0.8, 1),
    sample(0.8, 0),
    sample(0.8, 1),
    sample(0.8, 1),
  ], config, 2, config);

  const over = result.validation.families.goals_total_over_0_5;
  const rawOver = result.validation.raw.families.goals_total_over_0_5;
  const trainOver = result.validation.calibrationFamilies.goals_total_over_0_5;
  assert.equal(trainOver.n, 2);
  assert.equal(trainOver.avg_actual, 0.5);
  assert.equal(rawOver.avg_pred, 0.8);
  assert.ok(Math.abs(over.avg_pred - 0.7941176470588236) < 1e-12);
  assert.deepEqual(result.validation.horizons.early.families, result.validation.families);
  assert.equal(result.validation.horizons.probable.n, 0);
  assert.equal(result.validation.horizons.confirmed.n, 0);
});

test('el snapshot diagnóstico se reemplaza con una sola escritura set-based', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  await upsertDiagnostics(pool, {
    goals_total_over_0_5: {
      n: 10, avg_pred: 0.95, avg_actual: 0.9, brier: 0.08,
      high: { n: 10, avg_pred: 0.95, avg_actual: 0.9 },
      daily90: { n: 7, avg_pred: 0.92, avg_actual: 1 },
      elite95: { n: 4, avg_pred: 0.95, avg_actual: 1 },
    },
    cards_total_over_1_5: {
      n: 8, avg_pred: 0.82, avg_actual: 0.875, brier: 0.1,
      high: { n: 5, avg_pred: 0.84, avg_actual: 0.8 },
      daily90: { n: 0 },
      elite95: { n: 0 },
    },
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /DELETE FROM market_segment_diagnostics/);
  assert.match(calls[1].sql, /jsonb_to_recordset/);
  const rows = JSON.parse(calls[1].params[0]);
  assert.equal(rows.length, 10);
  assert.equal(rows.filter((row) => row.segment === 'validation-selectable70').length, 2);
  assert.equal(rows.filter((row) => row.segment === 'validation-daily90').length, 2);
});
