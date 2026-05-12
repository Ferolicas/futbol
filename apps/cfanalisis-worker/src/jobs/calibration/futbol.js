// @ts-nocheck
/**
 * Port of scripts/build-calibration.js as an ESM worker handler.
 *
 * Builds isotonic-regression calibration tables for the football model from
 * finalized rows in `match_predictions`, persists to
 * `app_config[calibration_dc_v1]`, and returns {before, after, diff} so the
 * /ferney panel can show what changed.
 */
import { supabaseAdmin } from '../../shared.js';

const KEY = 'calibration_dc_v1';
const MODEL_VERSION = 'dc-v1.1';

const MARKETS = [
  { key: 'home_win',      pCol: 'p_home_win',         outcome: r => r.actual_result === 'H', gate: r => r.actual_result != null },
  { key: 'draw',          pCol: 'p_draw',             outcome: r => r.actual_result === 'D', gate: r => r.actual_result != null },
  { key: 'away_win',      pCol: 'p_away_win',         outcome: r => r.actual_result === 'A', gate: r => r.actual_result != null },
  { key: 'btts',          pCol: 'p_btts',             outcome: r => r.actual_btts === true,  gate: r => r.actual_btts != null },
  { key: 'over_15',       pCol: 'p_over_15',          outcome: r => r.actual_total_goals > 1.5,  gate: r => r.actual_total_goals != null },
  { key: 'over_25',       pCol: 'p_over_25',          outcome: r => r.actual_total_goals > 2.5,  gate: r => r.actual_total_goals != null },
  { key: 'over_35',       pCol: 'p_over_35',          outcome: r => r.actual_total_goals > 3.5,  gate: r => r.actual_total_goals != null },
  { key: 'corners_85',    pCol: 'p_corners_over_85',  outcome: r => r.actual_corners > 8.5,      gate: r => r.actual_corners != null && r.actual_corners > 0 },
  { key: 'corners_95',    pCol: 'p_corners_over_95',  outcome: r => r.actual_corners > 9.5,      gate: r => r.actual_corners != null && r.actual_corners > 0 },
  { key: 'cards_25',      pCol: 'p_cards_over_25',    outcome: r => r.actual_total_cards > 2.5,  gate: r => r.actual_total_cards != null },
  { key: 'cards_35',      pCol: 'p_cards_over_35',    outcome: r => r.actual_total_cards > 3.5,  gate: r => r.actual_total_cards != null },
  { key: 'cards_45',      pCol: 'p_cards_over_45',    outcome: r => r.actual_total_cards > 4.5,  gate: r => r.actual_total_cards != null },
  { key: 'first_goal_30', pCol: 'p_first_goal_30',    outcome: r => r.actual_first_goal_minute != null && r.actual_first_goal_minute <= 30, gate: r => r.actual_total_goals != null },
  { key: 'first_goal_45', pCol: 'p_first_goal_45',    outcome: r => r.actual_first_goal_minute != null && r.actual_first_goal_minute <= 45, gate: r => r.actual_total_goals != null },
];

function isotonicPAV(points) {
  const n = points.length;
  if (n === 0) return [];
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  const ws = new Array(n).fill(1);
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

function buildKnots(rows, pCol, outcomeFn) {
  const buckets = {};
  for (const r of rows) {
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
    .sort((a, b) => a[0] - b[0]);

  const isoInput = points.map(([x, y]) => [x, y]);
  const iso = isotonicPAV(isoInput);

  const knots = [];
  if (iso.length === 0 || iso[0][0] > 0) knots.push([0, 0]);
  for (const [x, y] of iso) knots.push([x, Math.round(y * 10) / 10]);
  if (iso.length === 0 || iso[iso.length - 1][0] < 100) knots.push([100, 100]);

  return { knots, samples: points.map(([x, , n]) => ({ x, n })) };
}

/**
 * Compute a coarse per-market diff between two knot tables.
 *  - maxShift: largest |after_y - before_y| at the bucket centers 0..100 step 5
 *  - meanShift: average |Δ| across those points
 */
function knotDiff(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return null;
  const interp = (knots, x) => {
    if (knots.length === 0) return x;
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

export async function runFutbolCalibration() {
  // Snapshot the existing calibration before overwriting.
  const { data: currentRow } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', KEY)
    .maybeSingle();
  const before = currentRow?.value || null;

  // Load all finalized predictions.
  const { data: rows, error } = await supabaseAdmin
    .from('match_predictions')
    .select('*')
    .not('finalized_at', 'is', null);
  if (error) throw new Error(`fetch predictions: ${error.message}`);

  // Build per-market knots.
  const calibration = {};
  const perMarket = [];
  for (const m of MARKETS) {
    const valid = rows.filter(r => r[m.pCol] != null && m.gate(r));
    const { knots, samples } = buildKnots(valid, m.pCol, m.outcome);
    const goodBuckets = samples.filter(s => s.n >= 20).length;
    const beforeKnots = before?.markets?.[m.key] || null;

    if (goodBuckets < 3) {
      perMarket.push({
        key: m.key,
        samples: valid.length,
        goodBuckets,
        status: 'skipped',
        reason: `solo ${goodBuckets} buckets con ≥20 muestras`,
        beforeKnots,
        afterKnots: null,
      });
      continue;
    }

    calibration[m.key] = knots;
    const diff = beforeKnots ? knotDiff(beforeKnots, knots) : null;
    perMarket.push({
      key: m.key,
      samples: valid.length,
      goodBuckets,
      status: 'calibrated',
      knotsCount: knots.length,
      beforeKnots,
      afterKnots: knots,
      diff,
    });
  }

  const after = {
    model_version: MODEL_VERSION,
    built_at: new Date().toISOString(),
    sample_size: rows.length,
    markets: calibration,
  };

  const { error: upErr } = await supabaseAdmin.from('app_config').upsert({
    key: KEY,
    value: after,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
  if (upErr) throw new Error(`persist: ${upErr.message}`);

  return {
    sport: 'futbol',
    sampleSize: rows.length,
    before: before ? {
      builtAt: before.built_at,
      sampleSize: before.sample_size,
      marketsCount: Object.keys(before.markets || {}).length,
    } : null,
    after: {
      builtAt: after.built_at,
      sampleSize: after.sample_size,
      marketsCount: Object.keys(calibration).length,
    },
    markets: perMarket,
  };
}
