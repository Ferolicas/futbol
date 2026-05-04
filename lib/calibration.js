// Runtime isotonic calibration for dc-v1 probabilities.
// Loads knots from app_config[calibration_dc_v1] (built offline by scripts/build-calibration.js)
// and applies piecewise-linear interpolation to map raw probabilities → calibrated probabilities.

import { supabaseAdmin } from './supabase';

const CACHE_TTL_MS = 60 * 60 * 1000;
let cache = null;
let cacheLoadedAt = 0;
let inflight = null;

async function loadKnots() {
  const now = Date.now();
  if (cache && now - cacheLoadedAt < CACHE_TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { data, error } = await supabaseAdmin
        .from('app_config')
        .select('value')
        .eq('key', 'calibration_dc_v1')
        .single();
      if (error || !data?.value?.markets) {
        cache = { markets: {}, model_version: 'dc-v1' };
      } else {
        cache = data.value;
      }
      cacheLoadedAt = Date.now();
    } catch {
      cache = { markets: {}, model_version: 'dc-v1' };
      cacheLoadedAt = Date.now();
    } finally {
      inflight = null;
    }
    return cache;
  })();
  return inflight;
}

function interpolate(knots, x) {
  if (!knots || knots.length === 0) return x;
  if (x <= knots[0][0]) return knots[0][1];
  const last = knots[knots.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i];
    if (x <= x1) {
      const [x0, y0] = knots[i - 1];
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return last[1];
}

/**
 * Apply calibration to a single probability for a given market key.
 * Returns the input unchanged if no knots are configured for that market.
 * Markets: home_win, draw, away_win, btts, over_15, over_25, over_35, corners_85, corners_95
 */
export async function calibrateProb(marketKey, rawPct) {
  if (rawPct == null || isNaN(rawPct)) return rawPct;
  const cfg = await loadKnots();
  const knots = cfg?.markets?.[marketKey];
  if (!knots) return rawPct;
  const out = interpolate(knots, rawPct);
  return Math.max(5, Math.min(95, Math.round(out)));
}

/**
 * Apply calibration to a full probabilities object produced by computeAllProbabilities.
 * Mutates and returns the same object. Adds `model_version: 'dc-v1.1'` when calibration is active.
 */
export async function calibrateProbabilities(probs) {
  const cfg = await loadKnots();
  if (!cfg?.markets || Object.keys(cfg.markets).length === 0) {
    probs.model_version = 'dc-v1';
    return probs;
  }
  const m = cfg.markets;
  const interp = (key, val) => (m[key] ? Math.max(5, Math.min(95, Math.round(interpolate(m[key], val)))) : val);

  // 1X2 — calibrate then renormalize so they sum to 100
  if (probs.winner) {
    const w = probs.winner;
    const cal = {
      home: interp('home_win', w.home),
      draw: interp('draw', w.draw),
      away: interp('away_win', w.away),
    };
    const total = cal.home + cal.draw + cal.away;
    if (total > 0) {
      probs.winner = {
        home: Math.round((cal.home / total) * 100),
        draw: Math.round((cal.draw / total) * 100),
        away: Math.round((cal.away / total) * 100),
      };
      // Fix rounding drift to keep sum=100
      const drift = 100 - (probs.winner.home + probs.winner.draw + probs.winner.away);
      if (drift !== 0) probs.winner.home += drift;
    }
  }

  if (probs.btts != null) {
    probs.btts = interp('btts', probs.btts);
    probs.bttsNo = Math.max(5, Math.min(95, 100 - probs.btts));
  }

  if (probs.overUnder) {
    const ou = probs.overUnder;
    if (ou.over15 != null) { ou.over15 = interp('over_15', ou.over15); ou.under15 = Math.max(5, Math.min(95, 100 - ou.over15)); }
    if (ou.over25 != null) { ou.over25 = interp('over_25', ou.over25); ou.under25 = Math.max(5, Math.min(95, 100 - ou.over25)); }
    if (ou.over35 != null) { ou.over35 = interp('over_35', ou.over35); ou.under35 = Math.max(5, Math.min(95, 100 - ou.over35)); }
  }

  if (probs.corners) {
    if (probs.corners.over85 != null) probs.corners.over85 = interp('corners_85', probs.corners.over85);
    if (probs.corners.over95 != null) probs.corners.over95 = interp('corners_95', probs.corners.over95);
    // over105 has no calibration data — extrapolate by applying corners_95 mapping
    if (probs.corners.over105 != null) probs.corners.over105 = interp('corners_95', probs.corners.over105);
  }

  if (probs.cards) {
    if (probs.cards.over25 != null) probs.cards.over25 = interp('cards_25', probs.cards.over25);
    if (probs.cards.over35 != null) probs.cards.over35 = interp('cards_35', probs.cards.over35);
    if (probs.cards.over45 != null) probs.cards.over45 = interp('cards_45', probs.cards.over45);
  }

  if (probs.firstGoal) {
    if (probs.firstGoal.before30 != null) probs.firstGoal.before30 = interp('first_goal_30', probs.firstGoal.before30);
    if (probs.firstGoal.before45 != null) probs.firstGoal.before45 = interp('first_goal_45', probs.firstGoal.before45);
  }

  probs.model_version = cfg.model_version || 'dc-v1.1';
  return probs;
}

export function _resetCalibrationCache() {
  cache = null;
  cacheLoadedAt = 0;
  inflight = null;
}
