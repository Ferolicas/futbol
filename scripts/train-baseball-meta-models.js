/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Paso 5 — Entrena 3 meta-modelos logísticos para baseball MLB.
//
// Mercados:
//   home_win                 — outcome: actual_result === 'H'
//   run_line_home_minus_15   — outcome: actual_run_diff >= 2 (home gana por 2+)
//   total_over_85            — outcome: actual_total_runs > 8.5
//
// Inputs: las 10 features de features_baseball (point-in-time, sin leakage).
// Labels: derivadas del BOXSCORE oficial (raw_api_payloads.endpoint='mlb-boxscore'
//   → payload.teams.{home,away}.teamStats.batting.runs). Es la fuente
//   autoritativa de runs anotadas (más fiable que el `score` del schedule).
//   JOIN con features_baseball por fixture_id. No usamos baseball_match_predictions
//   (solo ~109 finalized → muestra insuficiente para entrenar 10 features).
//
// Algoritmo: logística regularizada con SGD (mismo patrón que fútbol;
//   B1 en las decisiones del usuario). Salida persistida en prediction_models
//   con sport='baseball' (la tabla soporta multi-sport vía esa columna).
//
// SPLIT TEMPORAL: primeros 80% por fecha = train, últimos 20% = val. Esto
// evita leakage temporal y es coherente con la inferencia en producción
// (predecimos sobre fixtures que vienen DESPUÉS de los del training).
//
// ACTIVACIÓN: el nuevo modelo se inserta INACTIVO; solo se activa (y se
// desactivan las versiones anteriores) si val_logloss < base_logloss
// (bate al predictor trivial = base_rate constante).
//
//   node --env-file=.env scripts/train-baseball-meta-models.js
// También exportado `trainBaseballMetaModels({pool?})` para el cron baseball-retrain.
// ────────────────────────────────────────────────────────────────────────

try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');

// ── Configuración fija (alineada con scripts/train-meta-models.js de fútbol) ──
const MIN_SAMPLES   = 200;
const VAL_FRACTION  = 0.20;
const EPOCHS        = 800;
const LR            = 0.3;
const L2            = 0.02;

// 10 features point-in-time (orden estable — usar siempre el mismo orden:
// `model.features` lo persiste en weights y `predictWithModel` lo lee de ahí).
const BASEBALL_FEATURE_ORDER = [
  'home_win_rate_last_10',
  'home_runs_per_game_last_30',
  'home_runs_allowed_last_30',
  'away_win_rate_last_10',
  'away_runs_per_game_last_30',
  'away_runs_allowed_last_30',
  'home_starter_era_last_5',
  'away_starter_era_last_5',
  'is_division_game',
  'home_stadium_park_factor',
];

const MARKETS = [
  {
    key: 'home_win',
    outcome: r => r.home_score > r.away_score,
    gate:    r => r.home_score != null && r.away_score != null,
  },
  {
    key: 'run_line_home_minus_15',
    outcome: r => (r.home_score - r.away_score) >= 2,
    gate:    r => r.home_score != null && r.away_score != null,
  },
  {
    key: 'total_over_85',
    outcome: r => (r.home_score + r.away_score) > 8.5,
    gate:    r => r.home_score != null && r.away_score != null,
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────
function makePool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 5,
  });
}

const sigmoid  = z => 1 / (1 + Math.exp(-z));
const clamp01  = p => Math.max(1e-6, Math.min(1 - 1e-6, p));
const logloss  = (y, p) => { p = clamp01(p); return -(y * Math.log(p) + (1 - y) * Math.log(1 - p)); };
const round4   = v => v == null ? null : Math.round(v * 10000) / 10000;

// SGD logístico con estandarización + L2. Devuelve {bias, coefs, means, stds, features}.
function trainLogistic(samples, F = BASEBALL_FEATURE_ORDER) {
  const d = F.length, means = {}, stds = {};
  // Media + std SOLO sobre los valores no-NULL (imputación con la media después).
  for (const fn of F) {
    const vals = samples.map(s => s.features[fn]).filter(v => v != null && isFinite(v));
    const m = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const va = vals.length ? vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length : 0;
    means[fn] = m; stds[fn] = Math.sqrt(va) || 1;
  }
  const X = samples.map(s => F.map(fn => {
    const r = s.features[fn];
    const v = (r == null || !isFinite(r)) ? means[fn] : r;
    return (v - means[fn]) / stds[fn];
  }));
  const y = samples.map(s => s.y), n = X.length;
  let w = new Array(d).fill(0), b = 0;
  for (let ep = 0; ep < EPOCHS; ep++) {
    const dw = new Array(d).fill(0); let db = 0;
    for (let i = 0; i < n; i++) {
      let z = b; for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const dz = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) dw[j] += dz * X[i][j];
      db += dz;
    }
    for (let j = 0; j < d; j++) w[j] -= LR * (dw[j] / n + L2 * w[j]);
    b -= LR * (db / n);
  }
  const coefs = {}; F.forEach((fn, j) => { coefs[fn] = w[j]; });
  return { bias: b, coefs, means, stds, features: F };
}

// Predict — MISMA imputación que el train → paridad train↔runtime.
function predictWithModel(model, features) {
  let z = model.bias || 0;
  for (const fn of model.features) {
    const raw = features[fn];
    const v = (raw == null || !isFinite(raw)) ? model.means[fn] : raw;
    const std = model.stds[fn] || 1;
    z += (model.coefs[fn] || 0) * ((v - model.means[fn]) / std);
  }
  return 1 / (1 + Math.exp(-z));
}

// ── Carga features + outcomes (un solo SQL) ────────────────────────────
// JOIN con mlb-boxscore (fuente autoritativa de runs vía teamStats.batting.runs).
// Si el boxscore no existe o le faltan los teamStats, la fila no entra en el
// dataset (filtramos en SQL con IS NOT NULL para que la pérdida sea explícita).
async function loadDataset(pool) {
  const { rows } = await pool.query(`
    SELECT
      f.fixture_id,
      f.game_date,
      f.home_win_rate_last_10,
      f.home_runs_per_game_last_30,
      f.home_runs_allowed_last_30,
      f.away_win_rate_last_10,
      f.away_runs_per_game_last_30,
      f.away_runs_allowed_last_30,
      f.home_starter_era_last_5,
      f.away_starter_era_last_5,
      f.is_division_game,
      f.home_stadium_park_factor,
      (b.payload->'teams'->'home'->'teamStats'->'batting'->>'runs')::int AS home_score,
      (b.payload->'teams'->'away'->'teamStats'->'batting'->>'runs')::int AS away_score
    FROM features_baseball f
    JOIN raw_api_payloads b
      ON b.endpoint='mlb-boxscore' AND b.sub_key='boxscore' AND b.ref_id = f.fixture_id
    WHERE (b.payload->'teams'->'home'->'teamStats'->'batting'->>'runs') IS NOT NULL
      AND (b.payload->'teams'->'away'->'teamStats'->'batting'->>'runs') IS NOT NULL
    ORDER BY f.game_date ASC, f.fixture_id ASC
  `);
  return rows;
}

// ── Sample builder ──────────────────────────────────────────────────────
function rowToSample(r, market) {
  if (!market.gate(r)) return null;
  return {
    y: market.outcome(r) ? 1 : 0,
    features: {
      home_win_rate_last_10:      r.home_win_rate_last_10      != null ? Number(r.home_win_rate_last_10)      : null,
      home_runs_per_game_last_30: r.home_runs_per_game_last_30 != null ? Number(r.home_runs_per_game_last_30) : null,
      home_runs_allowed_last_30:  r.home_runs_allowed_last_30  != null ? Number(r.home_runs_allowed_last_30)  : null,
      away_win_rate_last_10:      r.away_win_rate_last_10      != null ? Number(r.away_win_rate_last_10)      : null,
      away_runs_per_game_last_30: r.away_runs_per_game_last_30 != null ? Number(r.away_runs_per_game_last_30) : null,
      away_runs_allowed_last_30:  r.away_runs_allowed_last_30  != null ? Number(r.away_runs_allowed_last_30)  : null,
      home_starter_era_last_5:    r.home_starter_era_last_5    != null ? Number(r.home_starter_era_last_5)    : null,
      away_starter_era_last_5:    r.away_starter_era_last_5    != null ? Number(r.away_starter_era_last_5)    : null,
      is_division_game:           r.is_division_game ? 1 : 0,
      home_stadium_park_factor:   r.home_stadium_park_factor != null ? Number(r.home_stadium_park_factor) : 1.0,
    },
  };
}

// ── Train + evaluate + persist (UN mercado) ────────────────────────────
async function trainAndPersistMarket(pool, market, rows) {
  // Split TEMPORAL: respeta el orden de game_date (rows ya viene ordenado ASC).
  const samples = rows.map(r => rowToSample(r, market)).filter(Boolean);
  if (samples.length < MIN_SAMPLES) {
    console.log(`  [${market.key}] solo ${samples.length} muestras (< ${MIN_SAMPLES}); skip`);
    return { skipped: true, n: samples.length };
  }

  const cut = Math.floor(samples.length * (1 - VAL_FRACTION));
  const train = samples.slice(0, cut);
  const val   = samples.slice(cut);

  const baseRate    = train.reduce((a, s) => a + s.y, 0) / train.length;
  const valBaseRate = val.reduce((a, s) => a + s.y, 0) / val.length;

  const model = trainLogistic(train, BASEBALL_FEATURE_ORDER);

  // Métricas en val (proxy honesto del rendimiento en producción).
  let valLL = 0, baseLL = 0, brier = 0, baseBrier = 0, correct = 0, baseCorrect = 0;
  for (const s of val) {
    const p = predictWithModel(model, s.features);
    valLL    += logloss(s.y, p);
    baseLL   += logloss(s.y, baseRate);
    brier    += (s.y - p) ** 2;
    baseBrier += (s.y - baseRate) ** 2;
    // Accuracy: cutoff 0.5 — coherente con cómo el frontend usaría la prob.
    if ((p >= 0.5 ? 1 : 0) === s.y) correct++;
    if ((baseRate >= 0.5 ? 1 : 0) === s.y) baseCorrect++;
  }
  valLL /= val.length; baseLL /= val.length;
  brier /= val.length; baseBrier /= val.length;
  const accuracy = correct / val.length;
  const baseAccuracy = baseCorrect / val.length;
  const beatsBaseline = valLL < baseLL;

  // Top-5 features por |coef| estandarizado (importancia relativa). Las
  // features están en la misma escala (z-score) → comparable directamente.
  const topFeatures = Object.entries(model.coefs)
    .map(([name, c]) => ({ name, coef: c, abs: Math.abs(c) }))
    .sort((a, b) => b.abs - a.abs)
    .slice(0, 5)
    .map(t => ({ feature: t.name, coef: round4(t.coef) }));

  const metrics = {
    n_total: samples.length, n_train: train.length, n_val: val.length,
    base_rate: round4(baseRate), val_base_rate: round4(valBaseRate),
    logloss: round4(valLL), base_logloss: round4(baseLL),
    brier: round4(brier), base_brier: round4(baseBrier),
    accuracy: round4(accuracy), base_accuracy: round4(baseAccuracy),
    beats_baseline: beatsBaseline,
    delta_logloss: round4(baseLL - valLL),
    top_features: topFeatures,
  };

  // Persistencia versionada en prediction_models (sport='baseball').
  const { rows: nv } = await pool.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
     FROM prediction_models WHERE sport='baseball' AND market_key=$1`,
    [market.key]
  );
  const version = Number(nv[0]?.next_version || 1);

  await pool.query(
    `INSERT INTO prediction_models (sport, market_key, version, model_type, weights, metrics, active, trained_at)
     VALUES ('baseball', $1, $2, 'logistic', $3::jsonb, $4::jsonb, FALSE, NOW())`,
    [market.key, version, JSON.stringify(model), JSON.stringify(metrics)]
  );

  if (beatsBaseline) {
    // Desactivar versiones anteriores Y activar esta — todo en una transacción.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE prediction_models SET active = FALSE
         WHERE sport='baseball' AND market_key=$1 AND version <> $2`,
        [market.key, version]
      );
      await client.query(
        `UPDATE prediction_models SET active = TRUE
         WHERE sport='baseball' AND market_key=$1 AND version=$2`,
        [market.key, version]
      );
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    console.log(`  [${market.key}] v${version} ✓ ACTIVO — logloss ${metrics.logloss} < base ${metrics.base_logloss} (Δ=${metrics.delta_logloss}) | acc=${metrics.accuracy} (base ${metrics.base_accuracy})`);
  } else {
    console.log(`  [${market.key}] v${version} guardado INACTIVO — no bate baseline (val ll ${metrics.logloss} vs base ${metrics.base_logloss})`);
  }

  // Top-5 features por importancia — útil para auditar qué señales aprendió.
  console.log(`    top features (|coef|): ${topFeatures.map(t => `${t.feature}=${t.coef}`).join(', ')}`);

  // Warning específico para home_win — un modelo que no diferencia mejor que
  // base rate en este mercado es señal de que features+datos no alcanzan.
  if (market.key === 'home_win' && metrics.accuracy < 0.55) {
    console.warn(`    ⚠ ${market.key} accuracy=${metrics.accuracy} < 0.55 — modelo apenas distingue mejor que base. Revisar features / volumen de datos.`);
  }

  return { skipped: false, version, beatsBaseline, ...metrics };
}

// ── Main ────────────────────────────────────────────────────────────────
async function trainBaseballMetaModels(opts = {}) {
  const { pool: extPool = null } = opts;
  const pool = extPool || makePool();
  const ownPool = !extPool;

  console.log('================================================');
  console.log('  train-baseball-meta-models');
  console.log('================================================');
  console.log(`Mercados: ${MARKETS.map(m => m.key).join(', ')}`);
  console.log(`Features (${BASEBALL_FEATURE_ORDER.length}): ${BASEBALL_FEATURE_ORDER.join(', ')}`);
  console.log(`Min samples: ${MIN_SAMPLES} | Val: ${(VAL_FRACTION * 100).toFixed(0)}% | Epochs: ${EPOCHS} | LR: ${LR} | L2: ${L2}`);
  console.log('');

  try {
    console.log('[load] features_baseball JOIN raw_api_payloads mlb-schedule…');
    const t0 = Date.now();
    const rows = await loadDataset(pool);
    console.log(`[load] ${rows.length} games con features + score final en ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (rows.length < MIN_SAMPLES) {
      console.log(`\n⚠ Solo ${rows.length} muestras totales — necesito ≥${MIN_SAMPLES}. Aborto (correr reenrich-baseball antes).`);
      return { aborted: true, n: rows.length };
    }

    const oldest = rows[0]?.game_date;
    const newest = rows[rows.length - 1]?.game_date;
    console.log(`[load] rango temporal: ${oldest} → ${newest}`);

    console.log('\n[train] entrenando los 3 mercados…');
    const results = {};
    for (const market of MARKETS) {
      results[market.key] = await trainAndPersistMarket(pool, market, rows);
    }

    // Audit final.
    const { rows: activeRows } = await pool.query(
      `SELECT market_key, version, (metrics->>'n_train')::int AS n_train,
              (metrics->>'logloss')::float AS ll, (metrics->>'base_logloss')::float AS base_ll
       FROM prediction_models
       WHERE sport='baseball' AND active=TRUE
       ORDER BY market_key`
    );
    console.log('\n──────────────────────────────────────────────');
    console.log('MODELOS ACTIVOS (sport=baseball)');
    if (activeRows.length === 0) {
      console.log('  (ninguno — ningún modelo batió baseline)');
    } else {
      for (const r of activeRows) {
        console.log(`  ${r.market_key.padEnd(24)} v${r.version}  n_train=${r.n_train}  logloss=${r.ll.toFixed(4)} (base ${r.base_ll.toFixed(4)})`);
      }
    }
    console.log('──────────────────────────────────────────────');
    return { ok: true, results };
  } catch (e) {
    console.error('\nFATAL:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
    throw e;
  } finally {
    if (ownPool) await pool.end();
  }
}

if (require.main === module) {
  trainBaseballMetaModels().catch(() => process.exit(1));
}

module.exports = { trainBaseballMetaModels, BASEBALL_FEATURE_ORDER, predictWithModel, MARKETS };
