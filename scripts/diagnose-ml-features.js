/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Diagnóstico (read-only) de la sensibilidad del ML al contexto adverso.
// Responde:
//   1) Importancia de cada feature = media de |coef| (estandarizado) sobre los
//      modelos activos. ¿key_injury y knockout son de las menos influyentes?
//   2) ¿El features que llega al modelo con keyInjury/knockout=true realmente
//      lleva key_injury=1 / knockout=1?  (camino runtime)
//   3) En el crudo de entrenamiento, ¿cuántas muestras (fixtures finalizados)
//      tenían key_injury=1 y knockout=1? Si son pocas o key_injury≈siempre-1,
//      la señal es pobre y el ML no aprende causa→ruptura.
//   node --env-file=.env scripts/diagnose-ml-features.js
// ────────────────────────────────────────────────────────────────────────
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');
const { MARKET_DEFS } = require('../lib/meta-features');
const { phaseOf, FINISHED } = require('../lib/adn');
const { ruptureContext, buildRuptureFeatures, ML_FEATURE_ORDER } = require('../lib/context-engine');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 3,
});

(async () => {
  // ── 1) Importancia de features (media |coef| sobre modelos activos) ──
  console.log('\n══ 1) IMPORTANCIA DE FEATURES (media |coef| estandarizado, modelos activos) ══');
  const { rows: models } = await pool.query(
    `SELECT market_key, weights FROM prediction_models
     WHERE sport='football' AND active=TRUE AND model_type='rupture-logistic'`
  );
  const sumAbs = Object.fromEntries(ML_FEATURE_ORDER.map(f => [f, 0]));
  const cnt = Object.fromEntries(ML_FEATURE_ORDER.map(f => [f, 0]));
  for (const m of models) {
    const coefs = m.weights?.coefs || {};
    for (const f of ML_FEATURE_ORDER) {
      const c = coefs[f];
      if (c != null && isFinite(c)) { sumAbs[f] += Math.abs(c); cnt[f]++; }
    }
  }
  const ranked = ML_FEATURE_ORDER
    .map(f => ({ f, imp: cnt[f] ? sumAbs[f] / cnt[f] : 0 }))
    .sort((a, b) => b.imp - a.imp);
  console.log(`  modelos activos: ${models.length}`);
  ranked.forEach((r, i) => console.log(`   ${String(i + 1).padStart(2)}. ${r.f.padEnd(16)} ${r.imp.toFixed(4)}`));
  const ki = ranked.findIndex(r => r.f === 'key_injury') + 1;
  const ko = ranked.findIndex(r => r.f === 'knockout') + 1;
  console.log(`  → key_injury en puesto ${ki}/${ranked.length} · knockout en puesto ${ko}/${ranked.length} (1 = más influyente)`);

  // ── 2) Camino runtime: ¿keyInjury/knockout=true llegan al features? ──
  console.log('\n══ 2) CAMINO RUNTIME (¿el contexto adverso llega al features?) ══');
  const def = MARKET_DEFS.total_goals_over1_5;
  const rcOff = ruptureContext({ homeTeamRecords: [], awayTeamRecords: [], todayCtx: {}, beforeMs: Date.now() });
  const rcOn = ruptureContext({ homeTeamRecords: [], awayTeamRecords: [], todayCtx: { keyInjury: true, knockout: true }, beforeMs: Date.now() });
  const fOff = buildRuptureFeatures({ def, market: 'total_goals_over1_5', rc: rcOff, meetings: [], homeId: 1, awayId: 2, beforeMs: Date.now() });
  const fOn = buildRuptureFeatures({ def, market: 'total_goals_over1_5', rc: rcOn, meetings: [], homeId: 1, awayId: 2, beforeMs: Date.now() });
  console.log(`  todayCtx {} →            key_injury=${fOff.key_injury} knockout=${fOff.knockout}`);
  console.log(`  todayCtx {inj,ko:true} → key_injury=${fOn.key_injury} knockout=${fOn.knockout}  ${(fOn.key_injury === 1 && fOn.knockout === 1) ? '✓ llega bien' : '✗ NO llega'}`);

  // ── 3) Prevalencia en entrenamiento ──
  console.log('\n══ 3) PREVALENCIA EN ENTRENAMIENTO (crudo) ══');
  const [{ rows: fxRows }, { rows: injRows }] = await Promise.all([
    pool.query(`SELECT payload FROM raw_api_payloads WHERE endpoint='fixtures'`),
    pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='injuries' AND sub_key LIKE 'fx:%'`),
  ]);
  const injById = new Map(injRows.map(r => [Number(r.ref_id), r.payload]));
  let finished = 0, kiCount = 0, koCount = 0, injSum = 0, injFixturesWithRow = 0;
  for (const r of fxRows) {
    const f = r.payload;
    if (!FINISHED.has(f.fixture?.status?.short)) continue;
    finished++;
    const fid = Number(f.fixture?.id);
    const injPayload = injById.get(fid);
    const inj = injPayload?.response || injPayload || [];
    const hasInj = Array.isArray(inj) && inj.length > 0;
    if (injById.has(fid)) injFixturesWithRow++;
    if (hasInj) { kiCount++; injSum += inj.length; }
    if (phaseOf(f.league?.round) === 'knockout' || phaseOf(f.league?.round) === 'final') koCount++;
  }
  const pc = (n) => finished ? `${(100 * n / finished).toFixed(1)}%` : '0%';
  console.log(`  fixtures finalizados (muestras): ${finished}`);
  console.log(`  con injuries capturadas (hay fila fx:): ${injFixturesWithRow} (${pc(injFixturesWithRow)})`);
  console.log(`  key_injury=1 (injuries no vacías):       ${kiCount} (${pc(kiCount)})  ${kiCount < 200 ? '← POCAS: señal débil' : ''}`);
  console.log(`  promedio de lesionados por partido con datos: ${kiCount ? (injSum / kiCount).toFixed(1) : 0}`);
  console.log(`  knockout/final:                          ${koCount} (${pc(koCount)})  ${koCount < 200 ? '← POCAS: señal débil' : ''}`);
  console.log(`\n  Lectura: si key_injury≈100% (casi siempre hay ALGUNA lesión) es señal POBRE`);
  console.log(`  (no distingue "falta el goleador" de "falta un suplente") → el ML le da poco peso (correcto).`);

  // ── 4) MODELOS DIRECCIONALES por familia+sentido ──
  console.log('\n══ 4) MODELOS DIRECCIONALES POR FAMILIA+SENTIDO (key_injury / knockout) ══');
  const { rows: famRows } = await pool.query(
    `SELECT market_key, weights, metrics FROM prediction_models
     WHERE sport='football' AND active=TRUE AND model_type='family-directional'`
  );
  if (!famRows.length) {
    console.log('  ✗ No hay modelos direccionales activos. Re-entrena (train-meta-models.js) para generarlos.');
  } else {
    const fmt = (b) => { const pp = (1 / (1 + Math.exp(-b)) - 0.5) * 100; return `β=${b.toFixed(4)} (${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp@50%)`; };
    const list = famRows.map(r => ({ g: r.market_key, ki: r.weights?.ki || 0, ko: r.weights?.ko || 0, m: r.metrics || {} }))
      .sort((a, b) => (Math.abs(b.ki) + Math.abs(b.ko)) - (Math.abs(a.ki) + Math.abs(a.ko)));
    console.log(`  ${famRows.length} grupos activos (orden por |efecto|):`);
    console.log(`  ${'grupo'.padEnd(22)} ${'key_injury'.padEnd(26)} ${'knockout'.padEnd(26)} expo`);
    for (const f of list) {
      console.log(`  ${f.g.padEnd(22)} ${fmt(f.ki).padEnd(26)} ${fmt(f.ko).padEnd(26)} ki=${f.m.n_ki ?? '?'} ko=${f.m.n_ko ?? '?'}`);
    }
    console.log(`  (+pp = la señal SUBE la prob del mercado; −pp la BAJA. El runtime aplica el signo tal cual.)`);
  }

  await pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
