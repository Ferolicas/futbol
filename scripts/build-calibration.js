/* eslint-disable */
// ──────────────────────────────────────────────────────────────────────────
// Construye calibración isotonic regression desde match_predictions
// finalizadas. Guarda los nudos en app_config[calibration_dc_v1].
//
// MODOS:
//   - Si la fila tiene predictions_full + actuals_full (formato nuevo
//     post-Fase 4), usa esos JSONB para extraer probs/outcomes para
//     CUALQUIER mercado.
//   - Si solo tiene las columnas legacy (p_* + actual_*), se construye
//     la estructura equivalente para los mercados antiguos. Asi calibramos
//     usando TODA la historia disponible.
//
// MERCADOS calibrados:
//   - 1X2 (home_win, draw, away_win)
//   - BTTS (btts, btts_no)
//   - First goal (first_goal_30, first_goal_45)
//   - Over/Under DINAMICO para todos los grupos:
//       total_goals, total_corners, total_cards,
//       total_shots, total_sot, total_fouls,
//       home_goals, away_goals,
//       home_corners, away_corners,
//       home_cards, away_cards,
//       home_shots, away_shots,
//       home_fouls, away_fouls
//     Cada grupo emite over_K_5 y under_K_5 para K = 0..20.
//
// Run on VPS (carga env con --env-file, no dotenv):
//   cd /apps/futbol
//   node --env-file=.env scripts/build-calibration.js
// ──────────────────────────────────────────────────────────────────────────

// Soporta tanto Vercel (.env.local) como VPS (.env). Si Node 22 ya cargo
// el env via --env-file=.env, dotenv no hace nada (no overrides).
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

// ─── Estructura de mercados ────────────────────────────────────────────────
// Cada GROUP define como extraer la prob y el actual de cada fila.
// expandGroupMarkets emite over_K_5 y under_K_5 para K en [0, 20].

const SCALAR_MARKETS = [
  { key: 'home_win',  getProb: (p) => p?.winner?.home, getOutcome: (a) => a?.result === 'H', gate: (a) => a?.result != null },
  { key: 'draw',      getProb: (p) => p?.winner?.draw, getOutcome: (a) => a?.result === 'D', gate: (a) => a?.result != null },
  { key: 'away_win',  getProb: (p) => p?.winner?.away, getOutcome: (a) => a?.result === 'A', gate: (a) => a?.result != null },
  { key: 'btts',      getProb: (p) => p?.btts,         getOutcome: (a) => a?.goals?.btts === true,  gate: (a) => a?.goals?.btts != null },
  { key: 'btts_no',   getProb: (p) => p?.bttsNo,       getOutcome: (a) => a?.goals?.btts === false, gate: (a) => a?.goals?.btts != null },
  { key: 'first_goal_30', getProb: (p) => p?.firstGoal?.before30,
    getOutcome: (a) => a?.firstGoalMinute != null && a.firstGoalMinute <= 30,
    gate: (a) => a?.goals?.total != null },
  { key: 'first_goal_45', getProb: (p) => p?.firstGoal?.before45,
    getOutcome: (a) => a?.firstGoalMinute != null && a.firstGoalMinute <= 45,
    gate: (a) => a?.goals?.total != null },
];

const OU_GROUPS = {
  total_goals:   { probObj: (p) => p?.overUnder,                  actualValue: (a) => a?.goals?.total },
  total_corners: { probObj: (p) => p?.corners,                    actualValue: (a) => a?.corners?.total },
  total_cards:   { probObj: (p) => p?.cards,                      actualValue: (a) => a?.cards?.total },
  total_shots:   { probObj: (p) => p?.shots,                      actualValue: (a) => a?.shots?.total },
  total_sot:     { probObj: (p) => p?.sot,                        actualValue: (a) => a?.shots?.totalOnTarget },
  total_fouls:   { probObj: (p) => p?.fouls,                      actualValue: (a) => a?.fouls?.total },
  home_goals:    { probObj: (p) => p?.perTeam?.home?.goals,       actualValue: (a) => a?.goals?.home },
  away_goals:    { probObj: (p) => p?.perTeam?.away?.goals,       actualValue: (a) => a?.goals?.away },
  home_corners:  { probObj: (p) => p?.perTeam?.home?.corners,     actualValue: (a) => a?.corners?.home },
  away_corners:  { probObj: (p) => p?.perTeam?.away?.corners,     actualValue: (a) => a?.corners?.away },
  home_cards:    { probObj: (p) => p?.perTeam?.home?.cards,       actualValue: (a) => a?.cards?.home },
  away_cards:    { probObj: (p) => p?.perTeam?.away?.cards,       actualValue: (a) => a?.cards?.away },
  home_shots:    { probObj: (p) => p?.perTeamShots?.home,         actualValue: (a) => a?.shots?.home },
  away_shots:    { probObj: (p) => p?.perTeamShots?.away,         actualValue: (a) => a?.shots?.away },
  home_fouls:    { probObj: (p) => p?.perTeamFouls?.home,         actualValue: (a) => a?.fouls?.home },
  away_fouls:    { probObj: (p) => p?.perTeamFouls?.away,         actualValue: (a) => a?.fouls?.away },
};

function expandOuMarkets() {
  const out = [];
  for (const [groupKey, group] of Object.entries(OU_GROUPS)) {
    for (let k = 0; k <= 20; k++) {
      const overField  = `over${k}_5`;
      const underField = `under${k}_5`;
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

// ─── Legacy → JSONB normalization ────────────────────────────────────────
// Si la fila no tiene predictions_full/actuals_full, sintetizamos JSONB
// equivalente desde las columnas legacy (p_* y actual_*). Asi datos
// historicos siguen calibrando los mercados antiguos.

function rowToPredictions(row) {
  if (row.predictions_full) return row.predictions_full;
  return {
    winner: {
      home: row.p_home_win,
      draw: row.p_draw,
      away: row.p_away_win,
    },
    btts:    row.p_btts,
    bttsNo:  row.p_btts != null ? 100 - row.p_btts : null,
    overUnder: {
      over1_5: row.p_over_15,
      over2_5: row.p_over_25,
      over3_5: row.p_over_35,
    },
    corners: {
      over8_5: row.p_corners_over_85,
      over9_5: row.p_corners_over_95,
    },
    cards: {
      over2_5: row.p_cards_over_25,
      over3_5: row.p_cards_over_35,
      over4_5: row.p_cards_over_45,
    },
    firstGoal: {
      before30: row.p_first_goal_30,
      before45: row.p_first_goal_45,
    },
  };
}

function rowToActuals(row) {
  if (row.actuals_full) return row.actuals_full;
  return {
    result: row.actual_result,
    goals: {
      home:  row.actual_home_goals,
      away:  row.actual_away_goals,
      total: row.actual_total_goals,
      btts:  row.actual_btts,
    },
    corners: { total: row.actual_corners },
    cards:   { total: row.actual_total_cards },
    firstGoalMinute: row.actual_first_goal_minute,
  };
}

// ─── Isotonic regression (PAV) ────────────────────────────────────────────

function isotonicPAV(points) {
  const n = points.length;
  if (n === 0) return [];
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const ws = new Array(n).fill(1);
  let i = 0;
  while (i < n - 1) {
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

// Prior para shrinkage Bayesiano hacia la identidad. Con `total < PRIOR_N` la
// calibración apenas se desvía del raw_pct (porque no tenemos data suficiente
// para confiar en el empírico). A medida que `total` crece, el peso de la
// observación empírica supera al prior y la calibración converge al valor
// real. Esto permite registrar mercados desde la PRIMERA muestra sin que un
// solo dato (1/1 hits → 100%) distorsione la curva.
const SHRINKAGE_PRIOR_N = 10;

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
      // Laplace smoothing: evita 0% y 100% absolutos
      const empirical = (b.hits + 0.5) / (b.total + 1);
      // Shrinkage hacia identidad (x/100): si n=1 → casi raw, si n=100 → casi empírico
      const weight = b.total / (b.total + SHRINKAGE_PRIOR_N);
      const calibrated = empirical * weight + (x / 100) * (1 - weight);
      return [x, calibrated * 100, b.total];
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

// ─── Main ────────────────────────────────────────────────────────────────

(async () => {
  const { rows } = await pgPool.query(
    `SELECT * FROM match_predictions WHERE finalized_at IS NOT NULL`
  );
  console.log(`\nMuestras totales finalizadas: ${rows.length}`);
  const withFull = rows.filter(r => r.predictions_full && r.actuals_full).length;
  console.log(`  - Con predictions_full + actuals_full: ${withFull}`);
  console.log(`  - Legacy (solo p_* / actual_*): ${rows.length - withFull}`);

  // Normalize all rows
  for (const r of rows) {
    r._prob = rowToPredictions(r);
    r._actual = rowToActuals(r);
  }

  const calibration = {};
  const skipped = [];
  let calibrated = 0;

  for (const market of ALL_MARKETS) {
    const { knots, samples } = buildKnots(rows, market);
    // Gate mínimo: con AL MENOS 1 muestra ya calibramos (Stage P7 — usuario
    // quiere visibilidad desde la 1ra entrada, no esperar a 20). El shrinkage
    // hacia identidad en buildKnots evita que pocas muestras distorsionen.
    if (samples.length < 1) {
      skipped.push({ key: market.key, goodBuckets: 0, samples: 0 });
      continue;
    }
    const totalSamples = samples.reduce((acc, s) => acc + s.n, 0);
    calibration[market.key] = knots;
    calibrated++;
    if (calibrated <= 30) {
      console.log(`  ✓ ${market.key.padEnd(28)}  buckets=${samples.length}  n=${totalSamples}  knots=${knots.length}`);
    }
  }

  if (calibrated > 30) {
    console.log(`  ... y ${calibrated - 30} mercados mas calibrados`);
  }

  console.log(`\nResumen: ${calibrated} mercados calibrados, ${skipped.length} skipped por datos insuficientes`);

  // Persist
  const payload = {
    model_version: 'dc-v1.2',  // bump: ahora incluye todos los grupos OU
    built_at: new Date().toISOString(),
    sample_size: rows.length,
    markets: calibration,
    skipped_count: skipped.length,
  };

  await pgPool.query(
    `INSERT INTO app_config (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    ['calibration_dc_v1', JSON.stringify(payload)]
  );

  console.log(`\n✓ Calibracion guardada en app_config[calibration_dc_v1]`);
  console.log(`  model_version: ${payload.model_version}`);
  console.log(`  built_at:      ${payload.built_at}`);

  await pgPool.end();
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
