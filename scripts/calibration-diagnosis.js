/* eslint-disable */
// Diagnóstico de calibración del modelo dc-v1
// Lee match_predictions finalizadas, calcula Brier, log-loss y curva de calibración por mercado.
// Uso: node scripts/calibration-diagnosis.js

require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MARKETS = [
  { key: 'home_win',      pCol: 'p_home_win',      outcome: (r) => r.actual_result === 'H',           gate: (r) => r.actual_result != null,            label: '1 (Local gana)' },
  { key: 'draw',          pCol: 'p_draw',          outcome: (r) => r.actual_result === 'D',           gate: (r) => r.actual_result != null,            label: 'X (Empate)' },
  { key: 'away_win',      pCol: 'p_away_win',      outcome: (r) => r.actual_result === 'A',           gate: (r) => r.actual_result != null,            label: '2 (Visitante gana)' },
  { key: 'btts',          pCol: 'p_btts',          outcome: (r) => r.actual_btts === true,            gate: (r) => r.actual_btts != null,              label: 'BTTS' },
  { key: 'over_15',       pCol: 'p_over_15',       outcome: (r) => r.actual_total_goals > 1.5,        gate: (r) => r.actual_total_goals != null,       label: 'Over 1.5 goles' },
  { key: 'over_25',       pCol: 'p_over_25',       outcome: (r) => r.actual_total_goals > 2.5,        gate: (r) => r.actual_total_goals != null,       label: 'Over 2.5 goles' },
  { key: 'over_35',       pCol: 'p_over_35',       outcome: (r) => r.actual_total_goals > 3.5,        gate: (r) => r.actual_total_goals != null,       label: 'Over 3.5 goles' },
  { key: 'corners_85',    pCol: 'p_corners_over_85', outcome: (r) => r.actual_corners > 8.5,          gate: (r) => r.actual_corners != null && r.actual_corners > 0, label: 'Corners +8.5' },
  { key: 'corners_95',    pCol: 'p_corners_over_95', outcome: (r) => r.actual_corners > 9.5,          gate: (r) => r.actual_corners != null && r.actual_corners > 0, label: 'Corners +9.5' },
];

const BUCKETS = [
  [0, 10], [10, 20], [20, 30], [30, 40], [40, 50],
  [50, 60], [60, 70], [70, 80], [80, 90], [90, 100],
];

function bucketOf(p) {
  for (const [lo, hi] of BUCKETS) if (p >= lo && p < hi) return `${lo}-${hi}`;
  return p === 100 ? '90-100' : null;
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function brierScore(rows, pCol, outcomeFn) {
  return mean(rows.map((r) => {
    const p = r[pCol] / 100;
    const y = outcomeFn(r) ? 1 : 0;
    return (p - y) ** 2;
  }));
}

function logLoss(rows, pCol, outcomeFn) {
  const eps = 1e-9;
  return mean(rows.map((r) => {
    const p = Math.min(Math.max(r[pCol] / 100, eps), 1 - eps);
    const y = outcomeFn(r) ? 1 : 0;
    return -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }));
}

function expectedCalibrationError(rows, pCol, outcomeFn) {
  // ECE = sum over buckets: (n_bucket / N) * |avg_p - hit_rate|
  const buckets = {};
  for (const r of rows) {
    const b = bucketOf(r[pCol]);
    if (!b) continue;
    if (!buckets[b]) buckets[b] = { ps: [], outs: [] };
    buckets[b].ps.push(r[pCol] / 100);
    buckets[b].outs.push(outcomeFn(r) ? 1 : 0);
  }
  const N = rows.length;
  let ece = 0;
  for (const b of Object.values(buckets)) {
    const n = b.ps.length;
    if (n === 0) continue;
    const avgP = mean(b.ps);
    const hit = mean(b.outs);
    ece += (n / N) * Math.abs(avgP - hit);
  }
  return ece;
}

function calibrationTable(rows, pCol, outcomeFn) {
  const out = [];
  for (const [lo, hi] of BUCKETS) {
    const inB = rows.filter((r) => {
      const p = r[pCol];
      return hi === 100 ? p >= lo && p <= 100 : p >= lo && p < hi;
    });
    if (inB.length === 0) {
      out.push({ bucket: `${lo}-${hi}%`, n: 0, avg_pred: '—', hit_rate: '—', diff: '—', verdict: '—' });
      continue;
    }
    const avgP = mean(inB.map((r) => r[pCol]));
    const hits = inB.filter(outcomeFn).length;
    const hitRate = (hits / inB.length) * 100;
    const diff = hitRate - avgP;
    let verdict;
    if (inB.length < 10) verdict = '⚠ pocos datos';
    else if (Math.abs(diff) < 5) verdict = '✓ ok';
    else if (diff > 0) verdict = '↑ subestima';
    else verdict = '↓ sobreestima';
    out.push({
      bucket: `${lo}-${hi}%`,
      n: inB.length,
      avg_pred: avgP.toFixed(1) + '%',
      hit_rate: hitRate.toFixed(1) + '%',
      diff: (diff > 0 ? '+' : '') + diff.toFixed(1) + ' pp',
      verdict,
    });
  }
  return out;
}

(async () => {
  const { data: rows, error } = await s
    .from('match_predictions')
    .select('*')
    .not('finalized_at', 'is', null);

  if (error) { console.error('ERROR:', error.message); process.exit(1); }
  console.log(`\nMuestras finalizadas: ${rows.length}`);
  console.log('=' .repeat(80));

  const summary = [];

  for (const m of MARKETS) {
    const valid = rows.filter((r) => r[m.pCol] != null && m.gate(r));
    if (valid.length === 0) {
      console.log(`\n## ${m.label} — sin datos válidos`);
      continue;
    }

    const brier = brierScore(valid, m.pCol, m.outcome);
    const ll = logLoss(valid, m.pCol, m.outcome);
    const ece = expectedCalibrationError(valid, m.pCol, m.outcome);
    const overallHit = (valid.filter(m.outcome).length / valid.length) * 100;
    const overallPred = mean(valid.map((r) => r[m.pCol]));

    summary.push({
      mercado: m.label,
      n: valid.length,
      pred_avg: overallPred.toFixed(1) + '%',
      hit_avg: overallHit.toFixed(1) + '%',
      sesgo_global: ((overallHit - overallPred) > 0 ? '+' : '') + (overallHit - overallPred).toFixed(1) + ' pp',
      brier: brier.toFixed(4),
      log_loss: ll.toFixed(4),
      ece: (ece * 100).toFixed(2) + '%',
    });

    console.log(`\n## ${m.label}  (n=${valid.length})`);
    console.log(`   Brier: ${brier.toFixed(4)}  |  Log-loss: ${ll.toFixed(4)}  |  ECE: ${(ece * 100).toFixed(2)}%`);
    console.log(`   Predicción media: ${overallPred.toFixed(1)}%  vs  Hit real: ${overallHit.toFixed(1)}%  →  sesgo ${(overallHit - overallPred).toFixed(1)} pp`);
    console.table(calibrationTable(valid, m.pCol, m.outcome));
  }

  console.log('\n' + '='.repeat(80));
  console.log('RESUMEN GLOBAL POR MERCADO');
  console.table(summary);

  console.log('\nLEYENDA:');
  console.log('  Brier (0=perfecto, 0.25=baseline aleatorio, 0.5=peor caso)');
  console.log('  Log-loss (0=perfecto, ~0.69=baseline 50/50)');
  console.log('  ECE = error de calibración esperado (0=perfecto, 5%+ sesgo notable)');
  console.log('  Sesgo global: + = subestima (modelo conservador), - = sobreestima (modelo optimista)');
})();
