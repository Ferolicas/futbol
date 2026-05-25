// @ts-nocheck
/**
 * Calibración isotónica del modelo de fútbol — ejecutada por el botón
 * "Recalibrar fútbol" del panel /ferney (POST /admin/calibrate?sport=futbol).
 *
 * UNIFICADO con scripts/build-calibration.js (misma lógica, mismos mercados,
 * mismo model_version). Antes este handler era una versión VIEJA divergente
 * (solo 14 mercados legacy, dc-v1.1, gate ≥20 muestras) que al pulsarlo
 * SOBRESCRIBÍA la calibración buena (259 mercados, dc-v1.2) con la pobre.
 *
 * Lee match_predictions finalizadas del PG VPS (vía supabaseAdmin = pgAdmin
 * proxy, NO Supabase real), construye knots por mercado, persiste en
 * app_config[calibration_dc_v1], y devuelve {before, after, markets[]} con el
 * diff por mercado para que el panel muestre qué cambió.
 *
 * Mercados: 1X2, BTTS, first-goal + over/under DINÁMICO (K=0..20) para 16
 * grupos (total/per-team de goals, corners, cards, shots, sot, fouls).
 */
import { supabaseAdmin } from '../../shared.js';

const KEY = 'calibration_dc_v1';
const MODEL_VERSION = 'dc-v1.2';
const SHRINKAGE_PRIOR_N = 10;

// ─── Mercados (idéntico a scripts/build-calibration.js) ────────────────────
const SCALAR_MARKETS = [
  { key: 'home_win',  getProb: (p) => p?.winner?.home, getOutcome: (a) => a?.result === 'H', gate: (a) => a?.result != null },
  { key: 'draw',      getProb: (p) => p?.winner?.draw, getOutcome: (a) => a?.result === 'D', gate: (a) => a?.result != null },
  { key: 'away_win',  getProb: (p) => p?.winner?.away, getOutcome: (a) => a?.result === 'A', gate: (a) => a?.result != null },
  { key: 'btts',      getProb: (p) => p?.btts,         getOutcome: (a) => a?.goals?.btts === true,  gate: (a) => a?.goals?.btts != null },
  { key: 'btts_no',   getProb: (p) => p?.bttsNo,       getOutcome: (a) => a?.goals?.btts === false, gate: (a) => a?.goals?.btts != null },
  { key: 'first_goal_30', getProb: (p) => p?.firstGoal?.before30,
    getOutcome: (a) => a?.firstGoalMinute != null && a.firstGoalMinute <= 30, gate: (a) => a?.goals?.total != null },
  { key: 'first_goal_45', getProb: (p) => p?.firstGoal?.before45,
    getOutcome: (a) => a?.firstGoalMinute != null && a.firstGoalMinute <= 45, gate: (a) => a?.goals?.total != null },
];

const OU_GROUPS = {
  total_goals:   { probObj: (p) => p?.overUnder,              actualValue: (a) => a?.goals?.total },
  total_corners: { probObj: (p) => p?.corners,                actualValue: (a) => a?.corners?.total },
  total_cards:   { probObj: (p) => p?.cards,                  actualValue: (a) => a?.cards?.total },
  total_shots:   { probObj: (p) => p?.shots,                  actualValue: (a) => a?.shots?.total },
  total_sot:     { probObj: (p) => p?.sot,                    actualValue: (a) => a?.shots?.totalOnTarget },
  total_fouls:   { probObj: (p) => p?.fouls,                  actualValue: (a) => a?.fouls?.total },
  home_goals:    { probObj: (p) => p?.perTeam?.home?.goals,   actualValue: (a) => a?.goals?.home },
  away_goals:    { probObj: (p) => p?.perTeam?.away?.goals,   actualValue: (a) => a?.goals?.away },
  home_corners:  { probObj: (p) => p?.perTeam?.home?.corners, actualValue: (a) => a?.corners?.home },
  away_corners:  { probObj: (p) => p?.perTeam?.away?.corners, actualValue: (a) => a?.corners?.away },
  home_cards:    { probObj: (p) => p?.perTeam?.home?.cards,   actualValue: (a) => a?.cards?.home },
  away_cards:    { probObj: (p) => p?.perTeam?.away?.cards,   actualValue: (a) => a?.cards?.away },
  home_shots:    { probObj: (p) => p?.perTeamShots?.home,     actualValue: (a) => a?.shots?.home },
  away_shots:    { probObj: (p) => p?.perTeamShots?.away,     actualValue: (a) => a?.shots?.away },
  home_fouls:    { probObj: (p) => p?.perTeamFouls?.home,     actualValue: (a) => a?.fouls?.home },
  away_fouls:    { probObj: (p) => p?.perTeamFouls?.away,     actualValue: (a) => a?.fouls?.away },
};

function expandOuMarkets() {
  const out = [];
  for (const [groupKey, group] of Object.entries(OU_GROUPS)) {
    for (let k = 0; k <= 20; k++) {
      const overField = `over${k}_5`, underField = `under${k}_5`;
      const threshold = k + 0.5;
      out.push({
        key: `${groupKey}_${overField}`,
        getProb:    (p) => group.probObj(p)?.[overField],
        getOutcome: (a) => { const v = group.actualValue(a); return v != null && v > threshold; },
        gate:       (a) => group.actualValue(a) != null,
      });
      out.push({
        key: `${groupKey}_${underField}`,
        getProb:    (p) => group.probObj(p)?.[underField],
        getOutcome: (a) => { const v = group.actualValue(a); return v != null && v < threshold; },
        gate:       (a) => group.actualValue(a) != null,
      });
    }
  }
  return out;
}

const ALL_MARKETS = [...SCALAR_MARKETS, ...expandOuMarkets()];

// ─── Legacy → JSONB normalization (idéntico al script) ─────────────────────
function rowToPredictions(row) {
  if (row.predictions_full) return row.predictions_full;
  return {
    winner: { home: row.p_home_win, draw: row.p_draw, away: row.p_away_win },
    btts:   row.p_btts,
    bttsNo: row.p_btts != null ? 100 - row.p_btts : null,
    overUnder: { over1_5: row.p_over_15, over2_5: row.p_over_25, over3_5: row.p_over_35 },
    corners:   { over8_5: row.p_corners_over_85, over9_5: row.p_corners_over_95 },
    cards:     { over2_5: row.p_cards_over_25, over3_5: row.p_cards_over_35, over4_5: row.p_cards_over_45 },
    firstGoal: { before30: row.p_first_goal_30, before45: row.p_first_goal_45 },
  };
}

function rowToActuals(row) {
  if (row.actuals_full) return row.actuals_full;
  return {
    result: row.actual_result,
    goals:  { home: row.actual_home_goals, away: row.actual_away_goals, total: row.actual_total_goals, btts: row.actual_btts },
    corners: { total: row.actual_corners },
    cards:   { total: row.actual_total_cards },
    firstGoalMinute: row.actual_first_goal_minute,
  };
}

// ─── Isotonic regression (PAV) ─────────────────────────────────────────────
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

// buildKnots con shrinkage bayesiano hacia identidad (idéntico al script).
function buildKnots(rows, market) {
  const buckets = {};
  for (const r of rows) {
    const p = market.getProb(r._prob);
    if (p == null) continue;
    if (!market.gate(r._actual)) continue;
    const center = Math.round(p / 5) * 5;
    if (!buckets[center]) buckets[center] = { hits: 0, total: 0 };
    buckets[center].total++;
    if (market.getOutcome(r._actual)) buckets[center].hits++;
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

  const iso = isotonicPAV(points.map(([x, y]) => [x, y]));
  const knots = [];
  if (iso.length === 0 || iso[0][0] > 0) knots.push([0, 0]);
  for (const [x, y] of iso) knots.push([x, Math.round(y * 10) / 10]);
  if (iso.length === 0 || iso[iso.length - 1][0] < 100) knots.push([100, 100]);

  return { knots, samples: points.map(([x, , n]) => ({ x, n })) };
}

// Diff coarse por mercado (para el panel /ferney) — sin cambios.
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
  // Snapshot de la calibración existente antes de sobrescribir.
  const { data: currentRow } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', KEY)
    .maybeSingle();
  const before = currentRow?.value || null;

  // Cargar todas las predicciones finalizadas del PG VPS.
  const { data: rows, error } = await supabaseAdmin
    .from('match_predictions')
    .select('*')
    .not('finalized_at', 'is', null);
  if (error) throw new Error(`fetch predictions: ${error.message}`);

  // Normalizar cada fila a {_prob, _actual} (predictions_full/actuals_full o legacy).
  for (const r of rows) {
    r._prob = rowToPredictions(r);
    r._actual = rowToActuals(r);
  }

  const calibration = {};
  const perMarket = [];
  for (const m of ALL_MARKETS) {
    const { knots, samples } = buildKnots(rows, m);
    const totalSamples = samples.reduce((acc, s) => acc + s.n, 0);
    const beforeKnots = before?.markets?.[m.key] || null;

    // Gate ≥1 muestra (igual que el script). El shrinkage evita distorsión
    // con pocas muestras, así que no exigimos ≥20.
    if (samples.length < 1) {
      perMarket.push({
        key: m.key, samples: 0, status: 'skipped',
        reason: 'sin muestras', beforeKnots, afterKnots: null,
      });
      continue;
    }

    calibration[m.key] = knots;
    const diff = beforeKnots ? knotDiff(beforeKnots, knots) : null;
    perMarket.push({
      key: m.key,
      samples: totalSamples,
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

  // Orden del perMarket para el panel: primero los recalibrados con mayor
  // |maxShift| (los cambios más notables arriba), luego nuevos, luego skipped.
  perMarket.sort((x, y) => {
    const ax = Math.abs(x.diff?.maxShift ?? -1);
    const ay = Math.abs(y.diff?.maxShift ?? -1);
    return ay - ax;
  });

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
