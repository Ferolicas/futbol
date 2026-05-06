/* eslint-disable */
/**
 * Build baseball calibration knots via isotonic regression.
 * Reads finalized rows from baseball_match_predictions, groups predicted
 * probability into 5pp buckets, and computes empirical hit rates per bucket.
 * Stores monotone knots in app_config.calibration_baseball_v1.
 *
 * Run: node scripts/build-baseball-calibration.js
 *
 * Recommended cadence: weekly (more data → better calibration).
 * Minimum useful sample: ~150 finalized games per market.
 */

const fs = require('fs');
const path = require('path');

// Manual .env.local loader (consistent with seed-admin.js / send-promo-email.js)
const envPath = path.join(__dirname, '..', '.env.local');
const env = {};
if (fs.existsSync(envPath)) {
  const raw = fs.readFileSync(envPath, 'utf8').replace(/^﻿/, '');
  raw.split(/\r?\n/).forEach((rawLine) => {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq < 0) return;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  });
}
const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error('Missing Supabase env vars');
  process.exit(1);
}

const { createClient } = require('@supabase/supabase-js');
const s = createClient(SUPA_URL, SUPA_KEY);

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

// Pool Adjacent Violators — isotonic regression (monotone non-decreasing)
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
    .filter(([, , total]) => total >= 3) // minimum sample size per bucket
    .sort((a, b) => a[0] - b[0]);

  if (points.length < 2) return null;

  const isoPoints = isotonicPAV(points.map(p => [p[0], p[1]]));
  return isoPoints.map(([x, y]) => [Math.round(x), Math.round(y * 10) / 10]);
}

(async () => {
  console.log('[build-baseball-calibration] Fetching finalized predictions...');
  const { data: rows, error } = await s
    .from('baseball_match_predictions')
    .select('*')
    .not('finalized_at', 'is', null);

  if (error) {
    console.error('Supabase error:', error.message);
    process.exit(1);
  }
  console.log(`Loaded ${rows.length} finalized predictions`);

  if (rows.length < 30) {
    console.warn(`Only ${rows.length} samples. Need more games to build reliable calibration. Aborting.`);
    process.exit(0);
  }

  const knots = {};
  for (const m of MARKETS) {
    const k = buildKnots(rows, m.pCol, m.outcome, m.gate);
    if (k) {
      knots[m.key] = k;
      console.log(`  ✓ ${m.key.padEnd(28)} → ${k.length} knots, ex: ${JSON.stringify(k.slice(0, 3))}`);
    } else {
      console.log(`  ✗ ${m.key.padEnd(28)} → insufficient data`);
    }
  }

  // Save to app_config
  const { error: saveErr } = await s
    .from('app_config')
    .upsert({ key: 'calibration_baseball_v1', value: knots, updated_at: new Date().toISOString() });

  if (saveErr) {
    console.error('Save error:', saveErr.message);
    process.exit(1);
  }
  console.log('\n[build-baseball-calibration] Saved knots to app_config.calibration_baseball_v1');
  console.log(`Markets calibrated: ${Object.keys(knots).length}/${MARKETS.length}`);
})();
