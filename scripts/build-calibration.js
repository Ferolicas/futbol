/* eslint-disable */
// Construye tabla de calibración isotonic regression desde match_predictions finalizadas.
// Guarda los nudos en app_config bajo la clave `calibration_dc_v1` para que computeAllProbabilities los aplique.

require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MARKETS = [
  { key: 'home_win',     pCol: 'p_home_win',         outcome: (r) => r.actual_result === 'H',     gate: (r) => r.actual_result != null },
  { key: 'draw',         pCol: 'p_draw',             outcome: (r) => r.actual_result === 'D',     gate: (r) => r.actual_result != null },
  { key: 'away_win',     pCol: 'p_away_win',         outcome: (r) => r.actual_result === 'A',     gate: (r) => r.actual_result != null },
  { key: 'btts',         pCol: 'p_btts',             outcome: (r) => r.actual_btts === true,      gate: (r) => r.actual_btts != null },
  { key: 'over_15',      pCol: 'p_over_15',          outcome: (r) => r.actual_total_goals > 1.5,  gate: (r) => r.actual_total_goals != null },
  { key: 'over_25',      pCol: 'p_over_25',          outcome: (r) => r.actual_total_goals > 2.5,  gate: (r) => r.actual_total_goals != null },
  { key: 'over_35',      pCol: 'p_over_35',          outcome: (r) => r.actual_total_goals > 3.5,  gate: (r) => r.actual_total_goals != null },
  { key: 'corners_85',   pCol: 'p_corners_over_85',  outcome: (r) => r.actual_corners > 8.5,      gate: (r) => r.actual_corners != null && r.actual_corners > 0 },
  { key: 'corners_95',   pCol: 'p_corners_over_95',  outcome: (r) => r.actual_corners > 9.5,      gate: (r) => r.actual_corners != null && r.actual_corners > 0 },
  { key: 'cards_25',     pCol: 'p_cards_over_25',    outcome: (r) => r.actual_total_cards > 2.5,  gate: (r) => r.actual_total_cards != null },
  { key: 'cards_35',     pCol: 'p_cards_over_35',    outcome: (r) => r.actual_total_cards > 3.5,  gate: (r) => r.actual_total_cards != null },
  { key: 'cards_45',     pCol: 'p_cards_over_45',    outcome: (r) => r.actual_total_cards > 4.5,  gate: (r) => r.actual_total_cards != null },
  // Para "primer gol antes del minuto X": si el partido fue 0-0, no hay primer gol → contamos como NO ocurrido (false).
  { key: 'first_goal_30', pCol: 'p_first_goal_30',   outcome: (r) => r.actual_first_goal_minute != null && r.actual_first_goal_minute <= 30, gate: (r) => r.actual_total_goals != null },
  { key: 'first_goal_45', pCol: 'p_first_goal_45',   outcome: (r) => r.actual_first_goal_minute != null && r.actual_first_goal_minute <= 45, gate: (r) => r.actual_total_goals != null },
];

/**
 * Pool Adjacent Violators algorithm — isotonic regression.
 * Input: array of [x, y] sorted by x. Output: array of [x, y_iso] where y_iso is monotonically non-decreasing.
 */
function isotonicPAV(points) {
  const n = points.length;
  if (n === 0) return [];
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const ws = new Array(n).fill(1);
  // Pool adjacent violators
  let i = 0;
  while (i < n - 1) {
    if (ys[i] > ys[i + 1]) {
      // Merge i and i+1
      const newW = ws[i] + ws[i + 1];
      const newY = (ys[i] * ws[i] + ys[i + 1] * ws[i + 1]) / newW;
      ys[i] = newY; ws[i] = newW;
      ys.splice(i + 1, 1); ws.splice(i + 1, 1); xs.splice(i + 1, 1);
      // Step back to re-check
      if (i > 0) i--;
    } else {
      i++;
    }
  }
  return xs.map((x, idx) => [x, ys[idx]]);
}

/**
 * Build calibration knots for a market: groups predictions into 5pp wide buckets and runs isotonic.
 * Bucket centers: 5, 10, 15, ..., 95. Each bucket's y = empirical hit rate (with Laplace smoothing).
 */
function buildKnots(rows, pCol, outcomeFn) {
  const buckets = {};
  for (const r of rows) {
    const p = r[pCol];
    if (p == null) continue;
    // Round to nearest 5: 0, 5, 10, ..., 100
    const center = Math.round(p / 5) * 5;
    if (!buckets[center]) buckets[center] = { hits: 0, total: 0 };
    buckets[center].total++;
    if (outcomeFn(r)) buckets[center].hits++;
  }
  // Convert to [x, y] points with Laplace smoothing (add 0.5 hit + 0.5 miss to soften extremes)
  const points = Object.entries(buckets)
    .map(([center, b]) => {
      const x = Number(center);
      const smoothed = (b.hits + 0.5) / (b.total + 1);
      return [x, smoothed * 100, b.total];
    })
    .sort((a, b) => a[0] - b[0]);

  // Apply isotonic regression weighted by sample size
  const isoInput = points.map(([x, y]) => [x, y]);
  const iso = isotonicPAV(isoInput);

  // Anchor endpoints: ensure 0% maps to 0% and 100% maps to 100% if not already covered
  const knots = [];
  if (iso.length === 0 || iso[0][0] > 0) knots.push([0, 0]);
  for (const [x, y] of iso) knots.push([x, Math.round(y * 10) / 10]);
  if (iso.length === 0 || iso[iso.length - 1][0] < 100) knots.push([100, 100]);

  return { knots, samples: points.map(([x, , n]) => ({ x, n })) };
}

(async () => {
  const { data: rows, error } = await s
    .from('match_predictions')
    .select('*')
    .not('finalized_at', 'is', null);
  if (error) { console.error(error.message); process.exit(1); }
  console.log(`\nMuestras: ${rows.length}`);

  const calibration = {};
  const skipped = [];
  for (const m of MARKETS) {
    const valid = rows.filter((r) => r[m.pCol] != null && m.gate(r));
    const { knots, samples } = buildKnots(valid, m.pCol, m.outcome);
    // Gate de calidad: si la dispersión es degenerada (predicciones casi
    // todas iguales) la calibración isotónica empeora en lugar de mejorar.
    // Requiere ≥3 buckets con ≥20 muestras para considerarse fiable.
    const goodBuckets = samples.filter(s => s.n >= 20).length;
    if (goodBuckets < 3) {
      skipped.push({ key: m.key, n: valid.length, goodBuckets });
      console.log(`\n  ${m.key.padEnd(14)}  n=${valid.length}  ⚠ SKIP (solo ${goodBuckets} buckets fiables)`);
      continue;
    }
    calibration[m.key] = knots;
    console.log(`\n  ${m.key.padEnd(14)}  n=${valid.length}  knots=${knots.length}`);
    console.log('    ', knots.map(([x, y]) => `${x}→${y}`).join('  '));
  }
  if (skipped.length > 0) {
    console.log(`\n⚠ Mercados sin calibrar (datos insuficientes, se usa raw):`);
    skipped.forEach(s => console.log(`   - ${s.key}: ${s.goodBuckets} buckets con ≥20 muestras`));
  }

  // Persist to app_config
  const payload = {
    model_version: 'dc-v1.1',
    built_at: new Date().toISOString(),
    sample_size: rows.length,
    markets: calibration,
  };
  const { error: upErr } = await s.from('app_config').upsert({
    key: 'calibration_dc_v1',
    value: payload,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
  if (upErr) { console.error('Persist error:', upErr.message); process.exit(1); }
  console.log('\n✓ Calibración guardada en app_config[calibration_dc_v1]');
})();
