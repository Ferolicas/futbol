/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Entrena un META-MODELO logístico por mercado sobre los partidos finalizados
// CON features_full. Split temporal (entrena con lo viejo, valida con lo
// nuevo). Solo marca active=true el mercado cuyo meta-modelo SUPERA al baseline
// (la salida actual del sistema) en logloss de validación. Los que no superan
// quedan inactivos → el runtime sigue con la calibración isotónica. NO se
// excluye ningún mercado: se diagnostica.
//
//   node --env-file=.env scripts/train-meta-models.js
// ────────────────────────────────────────────────────────────────────────
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');
const { buildMetaFeatures, predictWithModel, MARKET_DEFS, FEATURE_ORDER } = require('../lib/meta-features');

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

const MIN_SAMPLES = 120;     // por debajo de esto no entrenamos (queda isotónica)
const VAL_FRACTION = 0.2;    // últimos 20% por fecha = validación
const EPOCHS = 900;
const LR = 0.3;
const L2 = 0.01;

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const clamp01 = (p) => Math.max(1e-6, Math.min(1 - 1e-6, p));
const logloss = (y, p) => { p = clamp01(p); return -(y * Math.log(p) + (1 - y) * Math.log(1 - p)); };

// Carga perfiles de equipo en memoria: teamId → { metric → {shrunk_value, sample_n, consistency} }.
async function loadProfiles() {
  const { rows } = await pgPool.query(
    `SELECT team_id, segment, metric, sample_n, shrunk_value, consistency FROM team_market_profiles WHERE sport='football'`
  );
  const map = {}; // teamId → segment → metric → {shrunk_value, sample_n, consistency}
  for (const r of rows) {
    const t = (map[r.team_id] = map[r.team_id] || {});
    const seg = (t[r.segment] = t[r.segment] || {});
    seg[r.metric] = { shrunk_value: r.shrunk_value, sample_n: r.sample_n, consistency: r.consistency };
  }
  return map;
}

// Entrena logística con descenso de gradiente + L2 sobre features estandarizadas.
function trainLogistic(samples) {
  const d = FEATURE_ORDER.length;
  // Imputación: media por columna (sobre no-nulos). Luego estandarización.
  const means = {}, stds = {};
  for (const fn of FEATURE_ORDER) {
    const vals = samples.map(s => s.features[fn]).filter(v => v != null && isFinite(v));
    const m = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const variance = vals.length ? vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length : 0;
    means[fn] = m; stds[fn] = Math.sqrt(variance) || 1;
  }
  const X = samples.map(s => FEATURE_ORDER.map(fn => {
    const raw = s.features[fn]; const v = (raw == null || !isFinite(raw)) ? means[fn] : raw;
    return (v - means[fn]) / stds[fn];
  }));
  const y = samples.map(s => s.y);
  const n = X.length;
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
  const coefs = {}; FEATURE_ORDER.forEach((fn, j) => { coefs[fn] = w[j]; });
  return { bias: b, coefs, means, stds, features: FEATURE_ORDER };
}

(async () => {
  const profiles = await loadProfiles();
  console.log(`Perfiles cargados: ${Object.keys(profiles).length} equipos`);

  const { rows } = await pgPool.query(
    `SELECT fixture_id, kickoff, home_team, away_team, predictions_full, features_full, actuals_full
     FROM match_predictions
     WHERE finalized_at IS NOT NULL AND features_full IS NOT NULL AND predictions_full IS NOT NULL AND actuals_full IS NOT NULL
     ORDER BY kickoff ASC`
  );
  console.log(`Partidos entrenables (con features): ${rows.length}\n`);
  if (rows.length < MIN_SAMPLES) { console.log('Datos insuficientes para entrenar todavía.'); await pgPool.end(); return; }

  const allMarkets = Object.keys(MARKET_DEFS);
  console.log(`Mercados en el catálogo: ${allMarkets.length} (escalares + over/under × líneas)\n`);
  const summary = [];
  let trained = 0, activated = 0, skipped = 0;
  for (const market of allMarkets) {
    const def = MARKET_DEFS[market];
    const samples = [];
    for (const r of rows) {
      if (!def.gate(r.actuals_full)) continue;
      const mf = buildMetaFeatures({
        featuresFull: r.features_full, predictionsFull: r.predictions_full,
        homeProfile: profiles[r.home_team?.id], awayProfile: profiles[r.away_team?.id], market,
      });
      if (!mf) continue;
      samples.push({ features: mf.features, base: mf.base, y: def.outcome(r.actuals_full) ? 1 : 0, kickoff: r.kickoff });
    }
    if (samples.length < MIN_SAMPLES) { skipped++; continue; }
    trained++;

    // Split temporal
    const cut = Math.floor(samples.length * (1 - VAL_FRACTION));
    const train = samples.slice(0, cut), val = samples.slice(cut);
    const model = trainLogistic(train);

    // Validación: meta vs baseline (prob base actual del sistema).
    let metaLL = 0, baseLL = 0, metaBr = 0, baseBr = 0;
    for (const s of val) {
      const pm = predictWithModel(model, s.features);
      metaLL += logloss(s.y, pm); baseLL += logloss(s.y, s.base);
      metaBr += (pm - s.y) ** 2; baseBr += (s.base - s.y) ** 2;
    }
    const nv = val.length;
    metaLL /= nv; baseLL /= nv; metaBr /= nv; baseBr /= nv;
    const beats = metaLL < baseLL;

    // Versionado
    const { rows: vr } = await pgPool.query(`SELECT COALESCE(MAX(version),0) AS v FROM prediction_models WHERE sport='football' AND market_key=$1`, [market]);
    const version = vr[0].v + 1;
    // Desactivar versiones previas; activar esta solo si supera al baseline.
    await pgPool.query(`UPDATE prediction_models SET active=FALSE WHERE sport='football' AND market_key=$1`, [market]);
    await pgPool.query(
      `INSERT INTO prediction_models (sport, market_key, version, model_type, weights, metrics, active, trained_at)
       VALUES ('football', $1, $2, 'logistic', $3::jsonb, $4::jsonb, $5, NOW())`,
      [market, version, JSON.stringify(model), JSON.stringify({
        n: samples.length, n_val: nv,
        logloss: round4(metaLL), brier: round4(metaBr),
        base_logloss: round4(baseLL), base_brier: round4(baseBr),
        beats_baseline: beats,
      }), beats]
    );
    if (beats) activated++;
    summary.push(`  ${market.padEnd(26)} n=${String(samples.length).padStart(4)}  LL meta=${metaLL.toFixed(4)} base=${baseLL.toFixed(4)}  ${beats ? '✓ ACTIVO' : '· (queda isotónica)'}`);
  }

  // Ordenar: activos primero, luego por mejora de logloss.
  console.log('Mercados entrenados:');
  console.log(summary.join('\n'));
  console.log(`\n══ RESUMEN ══`);
  console.log(`Catálogo: ${allMarkets.length} mercados · entrenados: ${trained} (≥${MIN_SAMPLES} muestras) · ACTIVOS: ${activated} · skip por datos: ${skipped}`);
  console.log('✓ Guardado en prediction_models. active=true solo donde el contexto supera al baseline.');
  await pgPool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

function round4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
