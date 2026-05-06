// Baseball calibration — applies isotonic regression knots stored in app_config.
// Mirrors lib/calibration logic for football, adapted to baseball markets.
//
// Knots are stored as { market: [[x, y], ...] } where x is the raw model
// probability (0-100) and y is the empirically-calibrated probability (0-100).
// Built periodically by scripts/build-baseball-calibration.js from finalized
// games in baseball_match_predictions.

import { supabaseAdmin } from './supabase';
import { redisGet, redisSet } from './redis';

const CONFIG_KEY = 'calibration_baseball_v1';
const CACHE_TTL = 6 * 3600;

let _knotsCache = null;
let _knotsCacheAt = 0;

async function loadKnots() {
  // In-memory cache (per-instance) — re-read every 6h max
  if (_knotsCache && Date.now() - _knotsCacheAt < CACHE_TTL * 1000) {
    return _knotsCache;
  }
  // Redis cache
  const redisCached = await redisGet(`baseball:calibration:knots`);
  if (redisCached) {
    _knotsCache = redisCached;
    _knotsCacheAt = Date.now();
    return redisCached;
  }
  // Supabase config
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', CONFIG_KEY)
    .maybeSingle();
  const knots = data?.value || {};
  _knotsCache = knots;
  _knotsCacheAt = Date.now();
  await redisSet(`baseball:calibration:knots`, knots, CACHE_TTL);
  return knots;
}

// Linear interpolation between two knots
function interpolate(x, lo, hi) {
  if (lo[0] === hi[0]) return lo[1];
  const t = (x - lo[0]) / (hi[0] - lo[0]);
  return lo[1] + t * (hi[1] - lo[1]);
}

function applyKnots(rawP, knots) {
  if (!Array.isArray(knots) || knots.length < 2) return rawP;
  if (rawP <= knots[0][0]) return knots[0][1];
  if (rawP >= knots[knots.length - 1][0]) return knots[knots.length - 1][1];

  for (let i = 0; i < knots.length - 1; i++) {
    if (rawP >= knots[i][0] && rawP <= knots[i + 1][0]) {
      return interpolate(rawP, knots[i], knots[i + 1]);
    }
  }
  return rawP;
}

/**
 * Calibrate a probability set object in-place.
 * Mapping from probabilities object keys to calibration market keys:
 *   moneyline.home → home_win
 *   moneyline.away → away_win
 *   totals.lines[7.5].over → total_over_75
 *   ... etc.
 */
export async function calibrateBaseballProbabilities(probs) {
  if (!probs) return probs;
  const knots = await loadKnots();
  if (!knots || Object.keys(knots).length === 0) return probs; // No data yet, return raw

  const out = JSON.parse(JSON.stringify(probs));
  const apply = (rawP, market) => {
    const k = knots[market];
    if (!k) return rawP;
    return Math.round(applyKnots(rawP, k));
  };

  // Moneyline
  if (out.moneyline) {
    out.moneyline.home = apply(out.moneyline.home, 'home_win');
    out.moneyline.away = apply(out.moneyline.away, 'away_win');
    // Re-normalize to sum 100
    const sum = out.moneyline.home + out.moneyline.away;
    if (sum > 0) {
      out.moneyline.home = Math.round((out.moneyline.home / sum) * 100);
      out.moneyline.away = 100 - out.moneyline.home;
    }
  }

  // Totals (per line)
  if (out.totals?.lines) {
    for (const [line, val] of Object.entries(out.totals.lines)) {
      const lineKey = `total_over_${String(line).replace('.', '')}`;
      val.over = apply(val.over, lineKey);
      val.under = 100 - val.over;
    }
  }

  // Run line
  if (out.runLine) {
    out.runLine.home_minus_1_5 = apply(out.runLine.home_minus_1_5, 'run_line_home_minus_15');
    out.runLine.away_plus_1_5 = 100 - out.runLine.home_minus_1_5;
    out.runLine.away_minus_1_5 = apply(out.runLine.away_minus_1_5, 'run_line_away_minus_15');
    out.runLine.home_plus_1_5 = 100 - out.runLine.away_minus_1_5;
  }

  // F5
  if (out.f5?.moneyline) {
    out.f5.moneyline.home = apply(out.f5.moneyline.home, 'f5_home_win');
    out.f5.moneyline.away = apply(out.f5.moneyline.away, 'f5_away_win');
  }
  if (out.f5?.totals) {
    for (const [line, val] of Object.entries(out.f5.totals)) {
      const lineKey = `f5_over_${String(line).replace('.', '')}`;
      val.over = apply(val.over, lineKey);
      val.under = 100 - val.over;
    }
  }

  // Team totals
  if (out.teamTotals?.home) {
    for (const [line, val] of Object.entries(out.teamTotals.home)) {
      const lineKey = `team_total_home_over_${String(line).replace('.', '')}`;
      val.over = apply(val.over, lineKey);
      val.under = 100 - val.over;
    }
  }
  if (out.teamTotals?.away) {
    for (const [line, val] of Object.entries(out.teamTotals.away)) {
      const lineKey = `team_total_away_over_${String(line).replace('.', '')}`;
      val.over = apply(val.over, lineKey);
      val.under = 100 - val.over;
    }
  }

  // BTTS
  if (out.btts) {
    out.btts.yes = apply(out.btts.yes, 'btts');
    out.btts.no = 100 - out.btts.yes;
  }

  // Cap displayed values to 95% (avoid overconfidence)
  const capDisplay = (v) => Math.min(95, Math.max(5, v));
  if (out.moneyline) {
    out.moneyline.home = capDisplay(out.moneyline.home);
    out.moneyline.away = capDisplay(out.moneyline.away);
  }
  return out;
}

export async function refreshCalibrationCache() {
  _knotsCache = null;
  _knotsCacheAt = 0;
  await redisSet(`baseball:calibration:knots`, null, 1);
}

// Helper used by predictions writer to extract the integer probabilities into
// flat columns of baseball_match_predictions.
export function flattenProbabilitiesForStorage(probs) {
  if (!probs) return {};
  return {
    p_home_win: probs.moneyline?.home ?? null,
    p_away_win: probs.moneyline?.away ?? null,
    p_total_over_75: probs.totals?.lines?.[7.5]?.over ?? null,
    p_total_over_85: probs.totals?.lines?.[8.5]?.over ?? null,
    p_total_over_95: probs.totals?.lines?.[9.5]?.over ?? null,
    p_total_over_105: probs.totals?.lines?.[10.5]?.over ?? null,
    p_run_line_home_minus_15: probs.runLine?.home_minus_1_5 ?? null,
    p_run_line_away_minus_15: probs.runLine?.away_minus_1_5 ?? null,
    p_f5_home_win: probs.f5?.moneyline?.home ?? null,
    p_f5_away_win: probs.f5?.moneyline?.away ?? null,
    p_f5_over_45: probs.f5?.totals?.[4.5]?.over ?? null,
    p_f5_over_55: probs.f5?.totals?.[5.5]?.over ?? null,
    p_btts: probs.btts?.yes ?? null,
    p_team_total_home_over_35: probs.teamTotals?.home?.[3.5]?.over ?? null,
    p_team_total_home_over_45: probs.teamTotals?.home?.[4.5]?.over ?? null,
    p_team_total_away_over_35: probs.teamTotals?.away?.[3.5]?.over ?? null,
    p_team_total_away_over_45: probs.teamTotals?.away?.[4.5]?.over ?? null,
    expected_home_runs: probs.expected?.lambdaHome ?? null,
    expected_away_runs: probs.expected?.lambdaAway ?? null,
  };
}
