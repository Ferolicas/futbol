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
// (Over0.5≈0.95, Over3.5≈0.25, gana local≈0.45, empate≈0.27…). Se mide con el
// MISMO def.gate/outcome que la familia del backtest → paridad total.
//
// Auto-ajuste: como corre periódicamente sobre TODOS los resultados, la base se
// mueve sola al llegar partidos nuevos (49/50 marcaron 2 goles → 0.98; si los 4
// siguientes no lo hacen → baja). Eso es lo que pidió el usuario: el modelo
// "aprende" de los resultados sin isotónica.
//
// Uso:  node --env-file=.env scripts/compute-market-base-rates.js
//       node --env-file=.env scripts/compute-market-base-rates.js --dry   (no escribe)
//
// Read-mostly: solo escribe filas base-rate en prediction_models (desactiva las
// previas). No toca runtime salvo que CONTEXT_SHRINK_ENABLED=true en el server.

const { Pool } = require('pg');
const { buildActuals, FINISHED } = require('../lib/adn');
const { MARKET_DEFS } = require('../lib/meta-features');

const MIN_BASE_N = 50;            // muestra mínima para un prior estable
const DRY = process.argv.includes('--dry');

function makePool() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL no definida'); process.exit(1); }
  return new Pool({ connectionString: url, max: 4 });
}

async function main() {
  const pool = makePool();
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
  const keys = Object.keys(MARKET_DEFS);
  const rows = [];
  let skippedLowN = 0;
  for (const key of keys) {
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

  if (DRY) { console.log('[base-rates] --dry: no se escribe nada.'); await pool.end(); return; }
  if (!rows.length) { console.error('[base-rates] sin mercados que escribir — abortando (no desactivo lo previo).'); await pool.end(); process.exit(1); }

  // Versión global nueva; desactiva la base-rate previa e inserta el snapshot.
  const { rows: vr } = await pool.query(`SELECT COALESCE(MAX(version),0)+1 AS v FROM prediction_models WHERE sport='football' AND model_type='base-rate'`);
  const version = vr[0].v;
  await pool.query(`UPDATE prediction_models SET active=FALSE WHERE sport='football' AND model_type='base-rate'`);
  await pool.query(
    `INSERT INTO prediction_models (sport, market_key, version, model_type, weights, metrics, active, trained_at)
     SELECT 'football', x.market_key, $1, 'base-rate', x.weights, x.metrics, TRUE, NOW()
     FROM jsonb_to_recordset($2::jsonb) AS x(market_key text, weights jsonb, metrics jsonb)`,
    [version, JSON.stringify(rows)]
  );
  console.log(`[base-rates] OK · escritas ${rows.length} tasas base activas (version=${version}).`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
