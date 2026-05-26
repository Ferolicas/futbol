/* eslint-disable */
/**
 * Build baseball calibration knots via isotonic regression + shrinkage bayesiano.
 * Lee filas finalizadas de baseball_match_predictions (Postgres VPS), agrupa la
 * probabilidad predicha en buckets de 5pp, calcula la tasa empírica con Laplace
 * y la encoge hacia la identidad (shrinkage) para no sobreajustar con pocas
 * muestras. Guarda knots monótonos en app_config.calibration_baseball_v1.
 *
 * UNIFICADO con apps/cfanalisis-worker/src/jobs/calibration/baseball.js (misma
 * lógica, mismos mercados). Antes este script leía de SUPABASE (datos viejos/
 * vacíos tras la migración a VPS) y usaba buildKnots SIN shrinkage ni bordes
 * anclados — correrlo podía SOBRESCRIBIR la calibración buena con una pobre.
 *
 * Run on VPS: node --env-file=.env scripts/build-baseball-calibration.js
 *
 * Cadencia recomendada: semanal (más datos → mejor calibración).
 */

try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

const MARKETS = [
  { key: 'home_win',                     pCol: 'p_home_win',                outcome: r => r.actual_result === 'H',          gate: r => r.actual_result != null },
  { key: 'away_win',                     pCol: 'p_away_win',                outcome: r => r.actual_result === 'A',          gate: r => r.actual_result != null },

  { key: 'total_over_75',                pCol: 'p_total_over_75',           outcome: r => r.actual_total_runs > 7.5,        gate: r => r.actual_total_runs != null },
  { key: 'total_over_85',                pCol: 'p_total_over_85',           outcome: r => r.actual_total_runs > 8.5,        gate: r => r.actual_total_runs != null },
  { key: 'total_over_95',                pCol: 'p_total_over_95',           outcome: r => r.actual_total_runs > 9.5,        gate: r => r.actual_total_runs != null },
  { key: 'total_over_105',               pCol: 'p_total_over_105',          outcome: r => r.actual_total_runs > 10.5,       gate: r => r.actual_total_runs != null },

  { key: 'run_line_home_minus_15',       pCol: 'p_run_line_home_minus_15',  outcome: r => r.actual_run_diff != null && r.actual_run_diff >= 2, gate: r => r.actual_run_diff != null },
  { key: 'run_line_away_minus_15',       pCol: 'p_run_line_away_minus_15',  outcome: r => r.actual_run_diff != null && r.actual_run_diff <= -2, gate: r => r.actual_run_diff != null },

  { key: 'f5_home_win',                  pCol: 'p_f5_home_win',             outcome: r => r.actual_f5_home_score != null && r.actual_f5_away_score != null && r.actual_f5_home_score > r.actual_f5_away_score, gate: r => r.actual_f5_home_score != null },
  { key: 'f5_away_win',                  pCol: 'p_f5_away_win',             outcome: r => r.actual_f5_home_score != null && r.actual_f5_away_score != null && r.actual_f5_away_score > r.actual_f5_home_score, gate: r => r.actual_f5_home_score != null },
  { key: 'f5_over_45',                   pCol: 'p_f5_over_45',              outcome: r => r.actual_f5_total > 4.5,          gate: r => r.actual_f5_total != null },
  { key: 'f5_over_55',                   pCol: 'p_f5_over_55',              outcome: r => r.actual_f5_total > 5.5,          gate: r => r.actual_f5_total != null },

  { key: 'btts',                         pCol: 'p_btts',                    outcome: r => r.actual_btts === true,           gate: r => r.actual_btts != null },

  { key: 'team_total_home_over_35',      pCol: 'p_team_total_home_over_35', outcome: r => r.actual_home_score > 3.5,        gate: r => r.actual_home_score != null },
  { key: 'team_total_home_over_45',      pCol: 'p_team_total_home_over_45', outcome: r => r.actual_home_score > 4.5,        gate: r => r.actual_home_score != null },
  { key: 'team_total_away_over_35',      pCol: 'p_team_total_away_over_35', outcome: r => r.actual_away_score > 3.5,        gate: r => r.actual_away_score != null },
  { key: 'team_total_away_over_45',      pCol: 'p_team_total_away_over_45', outcome: r => r.actual_away_score > 4.5,        gate: r => r.actual_away_score != null },
];

// Pool Adjacent Violators — isotonic regression (monótona no decreciente)
function isotonicPAV(points) {
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  const ws = points.map(() => 1);
  let i = 0;
  while (i < ys.length - 1) {
    if (ys[i] > ys[i + 1]) {
      const newW = ws[i] + ws[i + 1];
      const newY = (ys[i] * ws[i] + ys[i + 1] * ws[i + 1]) / newW;
      ys[i] = newY; ws[i] = newW;
      ys.splice(i + 1, 1); ws.splice(i + 1, 1); xs.splice(i + 1, 1);
      if (i > 0) i--;
    } else {
      i++;
    }
  }
  return xs.map((x, idx) => [x, ys[idx]]);
}

// Shrinkage hacia identidad (idéntico al job del worker y al motor de fútbol).
const SHRINKAGE_PRIOR_N = 10;

function buildKnots(rows, pCol, outcomeFn, gateFn) {
  const buckets = {};
  for (const r of rows) {
    if (!gateFn(r)) continue;
    const p = r[pCol];
    if (p == null) continue;
    const center = Math.round(p / 5) * 5;
    if (!buckets[center]) buckets[center] = { hits: 0, total: 0 };
    buckets[center].total++;
    if (outcomeFn(r)) buckets[center].hits++;
  }
  const points = Object.entries(buckets)
    .map(([center, b]) => {
      const x = Number(center);
      const empirical = (b.hits + 0.5) / (b.total + 1);
      const weight = b.total / (b.total + SHRINKAGE_PRIOR_N);
      const calibrated = empirical * weight + (x / 100) * (1 - weight);
      return [x, calibrated * 100, b.total];
    })
    .sort((a, b) => a[0] - b[0]);

  const sampleSize = points.reduce((s, p) => s + p[2], 0);
  if (points.length === 0) return { knots: null, sampleSize: 0 };

  const iso = isotonicPAV(points.map(p => [p[0], p[1]]));
  const knots = [];
  if (iso.length === 0 || iso[0][0] > 0) knots.push([0, 0]);
  for (const [x, y] of iso) knots.push([Math.round(x), Math.round(y * 10) / 10]);
  if (iso.length === 0 || iso[iso.length - 1][0] < 100) knots.push([100, 100]);

  return { knots, sampleSize };
}

(async () => {
  console.log('[build-baseball-calibration] Leyendo predicciones finalizadas (VPS)...');
  const { rows } = await pgPool.query(
    `SELECT * FROM baseball_match_predictions WHERE finalized_at IS NOT NULL`
  );
  console.log(`Cargadas ${rows.length} predicciones finalizadas`);

  if (rows.length < 10) {
    console.warn(`Solo ${rows.length} muestras. Se necesitan ≥10. Abortando.`);
    await pgPool.end();
    process.exit(0);
  }

  const knots = {};
  let calibrated = 0;
  for (const m of MARKETS) {
    const { knots: k, sampleSize } = buildKnots(rows, m.pCol, m.outcome, m.gate);
    if (k) {
      knots[m.key] = k;
      calibrated++;
      console.log(`  ✓ ${m.key.padEnd(28)} n=${sampleSize}  knots=${k.length}  ex: ${JSON.stringify(k.slice(0, 3))}`);
    } else {
      console.log(`  ✗ ${m.key.padEnd(28)} sin datos`);
    }
  }

  await pgPool.query(
    `INSERT INTO app_config (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    ['calibration_baseball_v1', JSON.stringify(knots)]
  );

  console.log(`\n✓ Guardado en app_config.calibration_baseball_v1`);
  console.log(`Mercados calibrados: ${calibrated}/${MARKETS.length}`);
  await pgPool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
