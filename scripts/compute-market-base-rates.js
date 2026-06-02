// scripts/compute-market-base-rates.js
//
// Calcula la TASA BASE (frecuencia real) de CADA mercado sobre TODOS los fixtures
// terminados y la persiste en prediction_models (model_type='base-rate'). Es el
// PRIOR del shrink bayesiano de calibración del motor de contexto:
//
//     p_calibrada = (n·p_observada + k·base) / (n + k)
//
// Con n chico manda la base; con n grande manda lo observado. Es por-CLAVE, no
// por-familia: cada línea Over/Under y cada resultado tiene su propia base
// (Over0.5≈0.92, Over3.5≈0.28, gana local≈0.44, empate≈0.26…). Se mide con el
// MISMO def.gate/outcome que la familia del backtest → paridad total.
//
// Auto-ajuste: el cron nocturno (futbol-retrain) lo re-corre tras finalize, así
// que la base se mueve sola al llegar partidos nuevos (49/50 marcaron 2 goles →
// 0.98; si los 4 siguientes no lo hacen → baja). Eso es el "aprende de los
// resultados" sin isotónica.
//
// Doble uso (igual que train-meta-models.js):
//   - CLI:    node --env-file=.env scripts/compute-market-base-rates.js [--dry]
//   - Worker: import('compute-market-base-rates.js').computeMarketBaseRates({ pool })
//
// Read-mostly: solo escribe filas base-rate en prediction_models (desactiva las
// previas). No toca runtime salvo que CONTEXT_SHRINK_ENABLED=true en el server.

const { Pool } = require('pg');
const { buildActuals, FINISHED } = require('../lib/adn');
const { MARKET_DEFS } = require('../lib/meta-features');

const MIN_BASE_N = 50;            // muestra mínima para un prior estable

// Núcleo reutilizable. Recibe un pg Pool (el caller es dueño de su ciclo de vida:
// el worker pasa su pgPool singleton y NO se cierra aquí; la CLI cierra el suyo).
async function computeMarketBaseRates({ pool, dry = false } = {}) {
  if (!pool) throw new Error('computeMarketBaseRates: falta pool');
  console.log('[base-rates] cargando crudo (fixtures + stats + events + halfstats)…');
  const [{ rows: fxRows }, { rows: stRows }, { rows: evRows }, { rows: hsRows }] = await Promise.all([
    pool.query(`SELECT ref_id,payload FROM raw_api_payloads WHERE endpoint='fixtures'`),
    pool.query(`SELECT ref_id,payload FROM raw_api_payloads WHERE endpoint='fixtures/statistics'`),
    pool.query(`SELECT ref_id,payload FROM raw_api_payloads WHERE endpoint='fixtures/events'`),
    pool.query(`SELECT ref_id,payload FROM raw_api_payloads WHERE endpoint='fixtures/halfstats'`),
  ]);
  const stById = new Map(stRows.map(r => [Number(r.ref_id), r.payload]));
  const evById = new Map(evRows.map(r => [Number(r.ref_id), r.payload]));
  const hsById = new Map(hsRows.map(r => [Number(r.ref_id), r.payload]));

  // Actuals reales de cada fixture terminado (misma def que el motor).
  const actualsList = [];
  for (const r of fxRows) {
    const f = r.payload;
    if (!FINISHED.has(f.fixture?.status?.short)) continue;
    const fid = Number(f.fixture?.id); if (!fid) continue;
    const a = buildActuals(f, stById.get(fid) || null, evById.get(fid) || null, hsById.get(fid) || null);
    if (a) actualsList.push(a);
  }
  console.log(`[base-rates] fixtures terminados con actuals: ${actualsList.length}`);

  // Frecuencia real por mercado: hits/n entre los que pasan def.gate.
  const rows = [];
  let skippedLowN = 0;
  for (const key of Object.keys(MARKET_DEFS)) {
    const def = MARKET_DEFS[key];
    let n = 0, hits = 0;
    for (const a of actualsList) { if (!def.gate(a)) continue; n++; if (def.outcome(a)) hits++; }
    if (n < MIN_BASE_N) { skippedLowN++; continue; }
    const rate = hits / n;
    rows.push({ market_key: key, weights: { rate: +rate.toFixed(6), n }, metrics: { n, base_pct: +(rate * 100).toFixed(2) } });
  }
  console.log(`[base-rates] mercados con base (n≥${MIN_BASE_N}): ${rows.length} · descartados por muestra baja: ${skippedLowN}`);

  // Muestra legible para verificar a ojo (categóricos + algunas líneas de conteo).
  const peek = ['home_win', 'draw', 'away_win', 'btts', 'btts_no', 'total_goals_over0_5', 'total_goals_over2_5', 'total_goals_over3_5', 'total_corners_over9_5', 'total_cards_over3_5'];
  for (const k of peek) { const r = rows.find(x => x.market_key === k); if (r) console.log(`   ${k.padEnd(26)} base=${(r.weights.rate * 100).toFixed(1)}%  (n=${r.weights.n})`); }

  if (dry) { console.log('[base-rates] --dry: no se escribe nada.'); return { ok: true, dry: true, markets: rows.length, fixtures: actualsList.length }; }
  if (!rows.length) { console.error('[base-rates] sin mercados que escribir — abortando (no desactivo lo previo).'); return { ok: false, markets: 0 }; }

  // La PK es (sport, market_key, version), COMPARTIDA entre model_types. Así que
  // la versión es POR-MERCADO = MAX(version) de cualquier tipo +1 (igual que el
  // trainer). Desactiva la base-rate previa e inserta el snapshot nuevo.
  const { rows: vrows } = await pool.query(`SELECT market_key, MAX(version) AS v FROM prediction_models WHERE sport='football' GROUP BY market_key`);
  const maxV = new Map(vrows.map(r => [r.market_key, Number(r.v) || 0]));
  for (const r of rows) r.version = (maxV.get(r.market_key) || 0) + 1;
  await pool.query(`UPDATE prediction_models SET active=FALSE WHERE sport='football' AND model_type='base-rate'`);
  await pool.query(
    `INSERT INTO prediction_models (sport, market_key, version, model_type, weights, metrics, active, trained_at)
     SELECT 'football', x.market_key, x.version, 'base-rate', x.weights, x.metrics, TRUE, NOW()
     FROM jsonb_to_recordset($1::jsonb) AS x(market_key text, version int, weights jsonb, metrics jsonb)`,
    [JSON.stringify(rows)]
  );
  console.log(`[base-rates] OK · escritas ${rows.length} tasas base activas (versión por-mercado).`);
  return { ok: true, markets: rows.length, fixtures: actualsList.length };
}

// CLI: crea su propio pool y lo cierra. El guard NO se dispara dentro del worker
// (import() dinámico) → ahí se usa computeMarketBaseRates({ pool }) con el pgPool.
if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL no definida'); process.exit(1); }
  const pool = new Pool({ connectionString: url, max: 4 });
  computeMarketBaseRates({ pool, dry: process.argv.includes('--dry') })
    .then(async (r) => { await pool.end(); process.exit(r && r.ok === false ? 1 : 0); })
    .catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
}

module.exports = { computeMarketBaseRates };
