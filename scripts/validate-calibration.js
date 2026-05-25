/* eslint-disable */
// Aplica la calibración guardada en app_config a las probs RAW de match_predictions
// y compara métricas (Brier, log-loss, ECE) antes vs después.
// No modifica datos — solo valida que la calibración mejora.
//
// Migrado de @supabase/supabase-js → pg (DATABASE_URL del VPS). Antes leía
// de Supabase (datos viejos pre-migración: 839 filas) mientras la
// calibración real se escribía/leía del PG del VPS (348 filas actuales) →
// los knots que validate-calibration buscaba en app_config de Supabase no
// existían o estaban desactualizados → interpolate caía al fallback
// "return x" (línea: if (!knots?.length) return x) → before === after →
// Δ=0pp en TODOS los mercados.
//
// Ahora lee de la misma fuente que build-calibration.js (DATABASE_URL),
// así before y after se calculan sobre datos coherentes y los knots son
// los recién generados.

// Soporta tanto Vercel (.env.local) como VPS (.env).
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

// IMPORTANTE: `key` debe COINCIDIR con la que escribe build-calibration.js
// en app_config[calibration_dc_v1].markets. build usa el esquema unificado
// `{grupo}_over{K}_5` / `{grupo}_under{K}_5` para los mercados OU desde
// dc-v1.2. Las keys legacy ('over_15', 'corners_85', etc.) ya no existen en
// el payload — usarlas devuelve undefined y la calibración aparece como '∅'
// con Δ=0 aunque los datos sí estén calibrados.
const MARKETS = [
  { key: 'home_win',     pCol: 'p_home_win',         outcome: (r) => r.actual_result === 'H',     gate: (r) => r.actual_result != null,                                  label: '1' },
  { key: 'draw',         pCol: 'p_draw',             outcome: (r) => r.actual_result === 'D',     gate: (r) => r.actual_result != null,                                  label: 'X' },
  { key: 'away_win',     pCol: 'p_away_win',         outcome: (r) => r.actual_result === 'A',     gate: (r) => r.actual_result != null,                                  label: '2' },
  { key: 'btts',         pCol: 'p_btts',             outcome: (r) => r.actual_btts === true,      gate: (r) => r.actual_btts != null,                                    label: 'BTTS' },
  { key: 'total_goals_over1_5',  pCol: 'p_over_15',          outcome: (r) => r.actual_total_goals > 1.5,  gate: (r) => r.actual_total_goals != null,                     label: 'O 1.5' },
  { key: 'total_goals_over2_5',  pCol: 'p_over_25',          outcome: (r) => r.actual_total_goals > 2.5,  gate: (r) => r.actual_total_goals != null,                     label: 'O 2.5' },
  { key: 'total_goals_over3_5',  pCol: 'p_over_35',          outcome: (r) => r.actual_total_goals > 3.5,  gate: (r) => r.actual_total_goals != null,                     label: 'O 3.5' },
  { key: 'total_corners_over8_5',pCol: 'p_corners_over_85',  outcome: (r) => r.actual_corners > 8.5,      gate: (r) => r.actual_corners != null && r.actual_corners > 0, label: 'C 8.5' },
  { key: 'total_corners_over9_5',pCol: 'p_corners_over_95',  outcome: (r) => r.actual_corners > 9.5,      gate: (r) => r.actual_corners != null && r.actual_corners > 0, label: 'C 9.5' },
  { key: 'total_cards_over2_5',  pCol: 'p_cards_over_25',    outcome: (r) => r.actual_total_cards > 2.5,  gate: (r) => r.actual_total_cards != null,                     label: 'Card 2.5' },
  { key: 'total_cards_over3_5',  pCol: 'p_cards_over_35',    outcome: (r) => r.actual_total_cards > 3.5,  gate: (r) => r.actual_total_cards != null,                     label: 'Card 3.5' },
  { key: 'total_cards_over4_5',  pCol: 'p_cards_over_45',    outcome: (r) => r.actual_total_cards > 4.5,  gate: (r) => r.actual_total_cards != null,                     label: 'Card 4.5' },
  { key: 'first_goal_30',pCol: 'p_first_goal_30',    outcome: (r) => r.actual_first_goal_minute != null && r.actual_first_goal_minute <= 30, gate: (r) => r.actual_total_goals != null, label: '1°gol≤30' },
  { key: 'first_goal_45',pCol: 'p_first_goal_45',    outcome: (r) => r.actual_first_goal_minute != null && r.actual_first_goal_minute <= 45, gate: (r) => r.actual_total_goals != null, label: '1°gol≤45' },
];

function interpolate(knots, x) {
  if (!knots?.length) return x;
  if (x <= knots[0][0]) return knots[0][1];
  const last = knots[knots.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i];
    if (x <= x1) {
      const [x0, y0] = knots[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return last[1];
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function metrics(rows, getP, outcomeFn) {
  const eps = 1e-9;
  const brier = mean(rows.map((r) => {
    const p = getP(r) / 100;
    const y = outcomeFn(r) ? 1 : 0;
    return (p - y) ** 2;
  }));
  const ll = mean(rows.map((r) => {
    const p = Math.min(Math.max(getP(r) / 100, eps), 1 - eps);
    const y = outcomeFn(r) ? 1 : 0;
    return -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }));
  // ECE with 10 buckets
  const buckets = {};
  for (const r of rows) {
    const b = Math.min(9, Math.floor(getP(r) / 10));
    if (!buckets[b]) buckets[b] = { ps: [], outs: [] };
    buckets[b].ps.push(getP(r) / 100);
    buckets[b].outs.push(outcomeFn(r) ? 1 : 0);
  }
  const N = rows.length;
  let ece = 0;
  for (const b of Object.values(buckets)) {
    const n = b.ps.length;
    if (n === 0) continue;
    ece += (n / N) * Math.abs(mean(b.ps) - mean(b.outs));
  }
  return { brier, ll, ece: ece * 100 };
}

(async () => {
  // 1) Leer todas las predicciones finalizadas desde el VPS.
  const { rows } = await pgPool.query(
    `SELECT * FROM match_predictions WHERE finalized_at IS NOT NULL`
  );

  // 2) Leer los knots desde el MISMO PG. La calibración la escribe
  //    build-calibration.js en app_config[calibration_dc_v1] con un
  //    payload jsonb { model_version, markets, ... }.
  const cfgRes = await pgPool.query(
    `SELECT value FROM app_config WHERE key = $1 LIMIT 1`,
    ['calibration_dc_v1'],
  );
  const cfgValue = cfgRes.rows[0]?.value;
  // jsonb llega ya parseado como objeto JS; defensa por si llegara como
  // string (configuraciones distintas de pg parsers en escenarios raros).
  const cfg = typeof cfgValue === 'string' ? JSON.parse(cfgValue) : cfgValue;
  if (!cfg?.markets) {
    console.error('No hay calibración en app_config[calibration_dc_v1]. Corre primero:');
    console.error('  node --env-file=.env scripts/build-calibration.js');
    process.exit(1);
  }
  const knotsByMarket = cfg.markets;

  console.log(`\nMuestras (match_predictions finalizadas en VPS): ${rows.length}`);
  console.log(`Modelo calibración: ${cfg.model_version}   built_at: ${cfg.built_at || '?'}`);
  console.log(`Mercados con knots: ${Object.keys(knotsByMarket).length}`);
  console.log('='.repeat(95));
  console.log('Métricas: ANTES (raw) → DESPUÉS (isotonic)\n');

  const summary = [];
  const missingKnots = [];
  for (const m of MARKETS) {
    const valid = rows.filter((r) => r[m.pCol] != null && m.gate(r));
    if (!valid.length) continue;
    const knots = knotsByMarket[m.key];
    if (!knots) missingKnots.push(m.key);
    const before = metrics(valid, (r) => r[m.pCol], m.outcome);
    // Si no hay knots, interpolate devuelve x → after === before → Δ=0pp
    // (síntoma del bug original). Lo registramos arriba en missingKnots.
    const after = metrics(valid, (r) => interpolate(knots, r[m.pCol]), m.outcome);
    summary.push({
      mercado: m.label,
      n: valid.length,
      brier_pre:  before.brier.toFixed(3),
      brier_post: after.brier.toFixed(3),
      Δbrier:     ((after.brier - before.brier) > 0 ? '+' : '') + (after.brier - before.brier).toFixed(3),
      logloss_pre:  before.ll.toFixed(3),
      logloss_post: after.ll.toFixed(3),
      ece_pre:  before.ece.toFixed(1) + '%',
      ece_post: after.ece.toFixed(1) + '%',
      Δece:     ((after.ece - before.ece) > 0 ? '+' : '') + (after.ece - before.ece).toFixed(1) + 'pp',
      knots: knots ? knots.length : '∅',
    });
  }
  console.table(summary);
  if (missingKnots.length > 0) {
    console.warn(`\n⚠ Mercados sin knots (Δ saldrá 0): ${missingKnots.join(', ')}`);
    console.warn('  Asegúrate de correr build-calibration.js primero.');
  }
  console.log('\nLectura: Δ negativo = mejora. Brier y log-loss más bajos = mejor calibración.');
  console.log('Columna "knots" = nº de nudos isotonic generados; "∅" = sin calibración para ese mercado.');

  await pgPool.end();
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
