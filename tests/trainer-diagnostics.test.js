const test = require('node:test');
const assert = require('node:assert/strict');

const { upsertDiagnostics } = require('../scripts/train-football-empirical-engine.js');

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
  assert.equal(rows.length, 8);
  assert.equal(rows.filter((row) => row.segment === 'validation-daily90').length, 2);
});
