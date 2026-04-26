/* eslint-disable */
// Aplica la calibración guardada en app_config a las probs RAW de match_predictions
// y compara métricas (Brier, log-loss, ECE) antes vs después.
// No modifica datos — solo valida que la calibración mejora.

require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MARKETS = [
  { key: 'home_win',   pCol: 'p_home_win',         outcome: (r) => r.actual_result === 'H',     gate: (r) => r.actual_result != null,                                  label: '1' },
  { key: 'draw',       pCol: 'p_draw',             outcome: (r) => r.actual_result === 'D',     gate: (r) => r.actual_result != null,                                  label: 'X' },
  { key: 'away_win',   pCol: 'p_away_win',         outcome: (r) => r.actual_result === 'A',     gate: (r) => r.actual_result != null,                                  label: '2' },
  { key: 'btts',       pCol: 'p_btts',             outcome: (r) => r.actual_btts === true,      gate: (r) => r.actual_btts != null,                                    label: 'BTTS' },
  { key: 'over_15',    pCol: 'p_over_15',          outcome: (r) => r.actual_total_goals > 1.5,  gate: (r) => r.actual_total_goals != null,                             label: 'O 1.5' },
  { key: 'over_25',    pCol: 'p_over_25',          outcome: (r) => r.actual_total_goals > 2.5,  gate: (r) => r.actual_total_goals != null,                             label: 'O 2.5' },
  { key: 'over_35',    pCol: 'p_over_35',          outcome: (r) => r.actual_total_goals > 3.5,  gate: (r) => r.actual_total_goals != null,                             label: 'O 3.5' },
  { key: 'corners_85', pCol: 'p_corners_over_85',  outcome: (r) => r.actual_corners > 8.5,      gate: (r) => r.actual_corners != null && r.actual_corners > 0,         label: 'C 8.5' },
  { key: 'corners_95', pCol: 'p_corners_over_95',  outcome: (r) => r.actual_corners > 9.5,      gate: (r) => r.actual_corners != null && r.actual_corners > 0,         label: 'C 9.5' },
];

function interpolate(knots, x) {
  if (!knots?.length) return x;
  if (x <= knots[0][0]) return knots[0][1];
  const last = knots[knots.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i];
    if (x <= x1) {
      const [x0, y0] = knots[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return last[1];
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function metrics(rows, getP, outcomeFn) {
  const eps = 1e-9;
  const brier = mean(rows.map((r) => {
    const p = getP(r) / 100;
    const y = outcomeFn(r) ? 1 : 0;
    return (p - y) ** 2;
  }));
  const ll = mean(rows.map((r) => {
    const p = Math.min(Math.max(getP(r) / 100, eps), 1 - eps);
    const y = outcomeFn(r) ? 1 : 0;
    return -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }));
  // ECE with 10 buckets
  const buckets = {};
  for (const r of rows) {
    const b = Math.min(9, Math.floor(getP(r) / 10));
    if (!buckets[b]) buckets[b] = { ps: [], outs: [] };
    buckets[b].ps.push(getP(r) / 100);
    buckets[b].outs.push(outcomeFn(r) ? 1 : 0);
  }
  const N = rows.length;
  let ece = 0;
  for (const b of Object.values(buckets)) {
    const n = b.ps.length;
    if (n === 0) continue;
    ece += (n / N) * Math.abs(mean(b.ps) - mean(b.outs));
  }
  return { brier, ll, ece: ece * 100 };
}

(async () => {
  const { data: rows, error } = await s.from('match_predictions').select('*').not('finalized_at', 'is', null);
  if (error) { console.error(error.message); process.exit(1); }

  const { data: cfg } = await s.from('app_config').select('value').eq('key', 'calibration_dc_v1').single();
  if (!cfg?.value?.markets) { console.error('No calibration in app_config'); process.exit(1); }
  const knotsByMarket = cfg.value.markets;

  console.log(`\nMuestras: ${rows.length}    Modelo calibración: ${cfg.value.model_version}`);
  console.log('='.repeat(95));
  console.log('Métricas: ANTES (raw dc-v1) → DESPUÉS (isotonic dc-v1.1)\n');

  const summary = [];
  for (const m of MARKETS) {
    const valid = rows.filter((r) => r[m.pCol] != null && m.gate(r));
    if (!valid.length) continue;
    const before = metrics(valid, (r) => r[m.pCol], m.outcome);
    const knots = knotsByMarket[m.key];
    const after = metrics(valid, (r) => interpolate(knots, r[m.pCol]), m.outcome);
    summary.push({
      mercado: m.label,
      n: valid.length,
      brier_pre:  before.brier.toFixed(3),
      brier_post: after.brier.toFixed(3),
      Δbrier:     ((after.brier - before.brier) > 0 ? '+' : '') + (after.brier - before.brier).toFixed(3),
      logloss_pre:  before.ll.toFixed(3),
      logloss_post: after.ll.toFixed(3),
      ece_pre:  before.ece.toFixed(1) + '%',
      ece_post: after.ece.toFixed(1) + '%',
      Δece:     ((after.ece - before.ece) > 0 ? '+' : '') + (after.ece - before.ece).toFixed(1) + 'pp',
    });
  }
  console.table(summary);
  console.log('\nLectura: Δ negativo = mejora. Brier y log-loss más bajos = mejor calibración.');
})();
