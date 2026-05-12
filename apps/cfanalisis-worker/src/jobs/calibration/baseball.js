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
      const smoothed = (b.hits + 0.5) / (b.total + 1);
      return [x, smoothed * 100, b.total];
    })
    .filter(([, , total]) => total >= 3)
    .sort((a, b) => a[0] - b[0]);

  if (points.length < 2) return { knots: null, sampleSize: points.reduce((s, p) => s + p[2], 0) };

  const isoPoints = isotonicPAV(points.map(p => [p[0], p[1]]));
  return {
    knots: isoPoints.map(([x, y]) => [Math.round(x), Math.round(y * 10) / 10]),
    sampleSize: points.reduce((s, p) => s + p[2], 0),
  };
}

function knotDiff(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return null;
  const interp = (knots, x) => {
    if (!knots || knots.length === 0) return x;
    for (let i = 1; i < knots.length; i++) {
      const [x0, y0] = knots[i - 1];
      const [x1, y1] = knots[i];
      if (x <= x1) {
        if (x1 === x0) return y0;
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return knots[knots.length - 1][1];
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

  if (!rows || rows.length < 30) {
    throw new Error(`Too few finalized predictions: ${rows?.length ?? 0} (need ≥30)`);
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
