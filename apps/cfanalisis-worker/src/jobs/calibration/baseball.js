// @ts-nocheck
/**
 * Port of scripts/build-baseball-calibration.js. Builds calibration table
 * for the baseball model from `baseball_match_predictions`, persists to
 * `app_config[calibration_baseball_v1]`, returns {before, after, per-market}.
 *
 * The baseball calibration is stored as a flat map { marketKey: knots[] }
 * (no top-level meta object) — that's the existing schema; we preserve it
 * here so consumers (lib/baseball-calibration.js) don't need to change.
 */
import { supabaseAdmin } from '../../shared.js';

const KEY = 'calibration_baseball_v1';

const MARKETS = [
  { key: 'home_win',                     pCol: 'p_home_win',                outcome: r => r.actual_result === 'H',                                                                                        gate: r => r.actual_result != null },
  { key: 'away_win',                     pCol: 'p_away_win',                outcome: r => r.actual_result === 'A',                                                                                        gate: r => r.actual_result != null },
  { key: 'total_over_75',                pCol: 'p_total_over_75',           outcome: r => r.actual_total_runs > 7.5,                                                                                      gate: r => r.actual_total_runs != null },
  { key: 'total_over_85',                pCol: 'p_total_over_85',           outcome: r => r.actual_total_runs > 8.5,                                                                                      gate: r => r.actual_total_runs != null },
  { key: 'total_over_95',                pCol: 'p_total_over_95',           outcome: r => r.actual_total_runs > 9.5,                                                                                      gate: r => r.actual_total_runs != null },
  { key: 'total_over_105',               pCol: 'p_total_over_105',          outcome: r => r.actual_total_runs > 10.5,                                                                                     gate: r => r.actual_total_runs != null },
  { key: 'run_line_home_minus_15',       pCol: 'p_run_line_home_minus_15',  outcome: r => r.actual_run_diff != null && r.actual_run_diff >= 2,                                                            gate: r => r.actual_run_diff != null },
  { key: 'run_line_away_minus_15',       pCol: 'p_run_line_away_minus_15',  outcome: r => r.actual_run_diff != null && r.actual_run_diff <= -2,                                                           gate: r => r.actual_run_diff != null },
  { key: 'f5_home_win',                  pCol: 'p_f5_home_win',             outcome: r => r.actual_f5_home_score != null && r.actual_f5_away_score != null && r.actual_f5_home_score > r.actual_f5_away_score, gate: r => r.actual_f5_home_score != null },
  { key: 'f5_away_win',                  pCol: 'p_f5_away_win',             outcome: r => r.actual_f5_home_score != null && r.actual_f5_away_score != null && r.actual_f5_away_score > r.actual_f5_home_score, gate: r => r.actual_f5_home_score != null },
  { key: 'f5_over_45',                   pCol: 'p_f5_over_45',              outcome: r => r.actual_f5_total > 4.5,                                                                                        gate: r => r.actual_f5_total != null },
  { key: 'f5_over_55',                   pCol: 'p_f5_over_55',              outcome: r => r.actual_f5_total > 5.5,                                                                                        gate: r => r.actual_f5_total != null },
  { key: 'btts',                         pCol: 'p_btts',                    outcome: r => r.actual_btts === true,                                                                                         gate: r => r.actual_btts != null },
  { key: 'team_total_home_over_35',      pCol: 'p_team_total_home_over_35', outcome: r => r.actual_home_score > 3.5,                                                                                      gate: r => r.actual_home_score != null },
  { key: 'team_total_home_over_45',      pCol: 'p_team_total_home_over_45', outcome: r => r.actual_home_score > 4.5,                                                                                      gate: r => r.actual_home_score != null },
  { key: 'team_total_away_over_35',      pCol: 'p_team_total_away_over_35', outcome: r => r.actual_away_score > 3.5,                                                                                      gate: r => r.actual_away_score != null },
  { key: 'team_total_away_over_45',      pCol: 'p_team_total_away_over_45', outcome: r => r.actual_away_score > 4.5,                                                                                      gate: r => r.actual_away_score != null },
];

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

// Prior de shrinkage bayesiano hacia la identidad (idéntico al motor de fútbol).
// Con `total < PRIOR_N` la calibración apenas se desvía del raw (x/100) porque
// no hay datos suficientes para confiar en el empírico. A medida que `total`
// crece, el peso del empírico supera al prior y converge al valor real. Esto
// evita el sobreajuste brutal que producían 48 muestras sin shrinkage (Δ de
// +124pp era ruido de pocos partidos, NO una calibración que mejora).
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
      // Laplace: evita 0%/100% absolutos con pocas muestras.
      const empirical = (b.hits + 0.5) / (b.total + 1);
      // Shrinkage hacia identidad: n pequeño → casi raw; n grande → casi empírico.
      const weight = b.total / (b.total + SHRINKAGE_PRIOR_N);
      const calibrated = empirical * weight + (x / 100) * (1 - weight);
      return [x, calibrated * 100, b.total];
    })
    .sort((a, b) => a[0] - b[0]);

  const sampleSize = points.reduce((s, p) => s + p[2], 0);
  // Con shrinkage ya no hace falta el gate de ≥3 por bucket: 1 muestra apenas
  // mueve la curva. Solo exigimos que exista AL MENOS un bucket con datos.
  if (points.length === 0) return { knots: null, sampleSize: 0 };

  const iso = isotonicPAV(points.map(p => [p[0], p[1]]));
  // Anclar bordes [0,0] y [100,100]: garantiza que el runtime y el diff NUNCA
  // extrapolen fuera del rango de datos (causa de los -468pp del panel). Mismo
  // criterio que el motor de fútbol.
  const knots = [];
  if (iso.length === 0 || iso[0][0] > 0) knots.push([0, 0]);
  for (const [x, y] of iso) knots.push([Math.round(x), Math.round(y * 10) / 10]);
  if (iso.length === 0 || iso[iso.length - 1][0] < 100) knots.push([100, 100]);

  return { knots, sampleSize };
}

function knotDiff(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return null;
  const interp = (knots, x) => {
    if (!knots || knots.length === 0) return x;
    // CLAMP fuera del rango (igual que el runtime applyKnots): si x está por
    // debajo del primer knot o por encima del último, devolver el valor del
    // borde, NUNCA extrapolar. La extrapolación lineal producía valores
    // imposibles (-468pp en x=0) cuando los knots no cubrían los extremos.
    if (x <= knots[0][0]) return knots[0][1];
    const last = knots[knots.length - 1];
    if (x >= last[0]) return last[1];
    for (let i = 1; i < knots.length; i++) {
      const [x0, y0] = knots[i - 1];
      const [x1, y1] = knots[i];
      if (x <= x1) {
        if (x1 === x0) return y0;
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return last[1];
  };
  let maxAbs = 0, sum = 0, count = 0, biggest = null;
  for (let x = 0; x <= 100; x += 5) {
    const a = interp(before, x), b = interp(after, x);
    const d = b - a;
    sum += Math.abs(d);
    count++;
    if (Math.abs(d) > Math.abs(maxAbs)) {
      maxAbs = d;
      biggest = { x, before: Math.round(a * 10) / 10, after: Math.round(b * 10) / 10, delta: Math.round(d * 10) / 10 };
    }
  }
  return { maxShift: Math.round(maxAbs * 10) / 10, meanShift: Math.round((sum / count) * 10) / 10, biggest };
}

export async function runBaseballCalibration() {
  const { data: currentRow } = await supabaseAdmin
    .from('app_config')
    .select('value, updated_at')
    .eq('key', KEY)
    .maybeSingle();
  const before = currentRow?.value || null;

  const { data: rows, error } = await supabaseAdmin
    .from('baseball_match_predictions')
    .select('*')
    .not('finalized_at', 'is', null);
  if (error) throw new Error(`fetch baseball predictions: ${error.message}`);

  if (!rows || rows.length < 10) {
    throw new Error(`Too few finalized predictions: ${rows?.length ?? 0} (need ≥10)`);
  }

  const calibration = {};
  const perMarket = [];

  for (const m of MARKETS) {
    const { knots, sampleSize } = buildKnots(rows, m.pCol, m.outcome, m.gate);
    const beforeKnots = before?.[m.key] || null;
    if (!knots) {
      perMarket.push({ key: m.key, samples: sampleSize, status: 'insufficient', beforeKnots, afterKnots: null });
      continue;
    }
    calibration[m.key] = knots;
    const diff = beforeKnots ? knotDiff(beforeKnots, knots) : null;
    perMarket.push({
      key: m.key,
      samples: sampleSize,
      status: 'calibrated',
      knotsCount: knots.length,
      beforeKnots,
      afterKnots: knots,
      diff,
    });
  }

  const { error: saveErr } = await supabaseAdmin.from('app_config').upsert({
    key: KEY,
    value: calibration,
    updated_at: new Date().toISOString(),
  });
  if (saveErr) throw new Error(`persist: ${saveErr.message}`);

  return {
    sport: 'baseball',
    sampleSize: rows.length,
    before: before ? {
      // Baseball schema is flat — best-effort metadata
      builtAt: currentRow?.updated_at || null,
      sampleSize: null,
      marketsCount: Object.keys(before).length,
    } : null,
    after: {
      builtAt: new Date().toISOString(),
      sampleSize: rows.length,
      marketsCount: Object.keys(calibration).length,
    },
    markets: perMarket,
  };
}
