/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Investigación (read-only) del efecto de key_injury / knockout POR MERCADO y
// POR FAMILIA — antes de tocar el ML.
//
// Hipótesis: el modelo agregado de ERROR dio ~0 porque (a) over baja y under sube
// (se cancela el signo) y/o (b) se promedia con ~480 mercados insensibles (tarjetas,
// córners, faltas, tiros) que diluyen la señal de goles.
//
// Mide, sobre el MISMO crudo y la MISMA definición de muestras que el trainer:
//   P(outcome | ki=0) vs P(outcome | ki=1)   con n y test z de 2 proporciones.
// Y agrega por familia para ver si goles se mueven mientras tarjetas/córners no.
//
//   node --env-file=.env scripts/diagnose-adverse-by-family.js
// ────────────────────────────────────────────────────────────────────────
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');
const { MARKET_DEFS } = require('../lib/meta-features');
const { recordFromRaw, buildActuals, FINISHED } = require('../lib/adn');
const { meetingRecord, modalXIFromLineups } = require('../lib/h2h');
const { isKeyInjury } = require('../lib/context-engine');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 3,
});

// Familia de un mercado (para agrupar la señal).
function family(k) {
  if (/^total_goals_/.test(k)) return 'goles_total';
  if (/^home_goals_/.test(k)) return 'goles_local';
  if (/^away_goals_/.test(k)) return 'goles_visit';
  if (/^btts/.test(k)) return 'btts';
  if (/^first_goal_/.test(k)) return 'primer_gol';
  if (/^goal_\d/.test(k)) return 'timing_gol';
  if (/^winner_1h/.test(k)) return 'resultado_1h';
  if (/^winner_2h/.test(k)) return 'resultado_2h';
  if (/cards?/.test(k)) return 'tarjetas';
  if (/corner/.test(k)) return 'corners';
  if (/foul/.test(k)) return 'faltas';
  if (/shot|sot/.test(k)) return 'tiros';
  if (/offside/.test(k)) return 'offsides';
  if (/^(home_win|away_win|draw)$/.test(k)) return 'resultado';
  if (/^ah_/.test(k)) return 'handicap';
  if (/^most_/.test(k)) return 'most_x';
  if (/^red_card/.test(k)) return 'roja';
  return 'otros';
}

// Test z de 2 proporciones (x1/n1 vs x0/n0). Devuelve {p0,p1,delta,z}.
function ztest(x0, n0, x1, n1) {
  if (!n0 || !n1) return null;
  const p0 = x0 / n0, p1 = x1 / n1;
  const p = (x0 + x1) / (n0 + n1);
  const se = Math.sqrt(p * (1 - p) * (1 / n0 + 1 / n1));
  const z = se > 0 ? (p1 - p0) / se : 0;
  return { p0, p1, delta: p1 - p0, z };
}
const pct = (p) => `${(100 * p).toFixed(1)}%`.padStart(6);
const sig = (z) => Math.abs(z) >= 3.29 ? '***' : Math.abs(z) >= 2.58 ? '**' : Math.abs(z) >= 1.96 ? '*' : '';

(async () => {
  console.log('\n[load] crudo (fixtures/lineups/statistics/events/injuries/halfstats)…');
  const [{ rows: fxRows }, { rows: luRows }, { rows: stRows }, { rows: evRows }, { rows: injRows }, { rows: hsRows }] = await Promise.all([
    pool.query(`SELECT payload FROM raw_api_payloads WHERE endpoint='fixtures'`),
    pool.query(`SELECT payload FROM raw_api_payloads WHERE endpoint='fixtures/lineups'`),
    pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures/statistics'`),
    pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures/events'`),
    pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='injuries' AND sub_key LIKE 'fx:%'`),
    pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures/halfstats'`),
  ]);
  const stById = new Map(stRows.map(r => [Number(r.ref_id), r.payload]));
  const evById = new Map(evRows.map(r => [Number(r.ref_id), r.payload]));
  const injById = new Map(injRows.map(r => [Number(r.ref_id), r.payload]));
  const hsById = new Map(hsRows.map(r => [Number(r.ref_id), r.payload]));

  // modalXIByTeam IGUAL que el trainer.
  const lineupsByTeam = new Map();
  for (const r of luRows) {
    const arr = r.payload?.response || r.payload || [];
    for (const l of (Array.isArray(arr) ? arr : [])) {
      const tid = l.team?.id; if (!tid) continue;
      if (!lineupsByTeam.has(tid)) lineupsByTeam.set(tid, []);
      lineupsByTeam.get(tid).push(r.payload);
    }
  }
  const modalXIByTeam = new Map();
  for (const [tid, payloads] of lineupsByTeam) modalXIByTeam.set(tid, modalXIFromLineups(payloads, tid));

  // Muestras: cada fixture finalizado → actuals + ki + ko.
  const samples = [];
  for (const r of fxRows) {
    const f = r.payload;
    if (!FINISHED.has(f.fixture?.status?.short)) continue;
    const fid = Number(f.fixture?.id);
    const actuals = buildActuals(f, stById.get(fid) || null, evById.get(fid) || null, hsById.get(fid) || null);
    if (!actuals) continue;
    const ki = isKeyInjury(injById.get(fid), modalXIByTeam) ? 1 : 0;
    const ko = (actuals.phase === 'knockout' || actuals.phase === 'final') ? 1 : 0;
    samples.push({ actuals, ki, ko });
  }
  const nKi = samples.filter(s => s.ki).length, nKo = samples.filter(s => s.ko).length;
  console.log(`[load] muestras finalizadas: ${samples.length} · key_injury=1: ${nKi} (${(100 * nKi / samples.length).toFixed(1)}%) · knockout=1: ${nKo} (${(100 * nKo / samples.length).toFixed(1)}%)`);

  // Por mercado: tasas condicionales para ki y ko.
  const allMarkets = Object.keys(MARKET_DEFS);
  const rows = []; // {k, fam, ki:{...}, ko:{...}}
  for (const k of allMarkets) {
    const def = MARKET_DEFS[k];
    let x0i = 0, n0i = 0, x1i = 0, n1i = 0, x0k = 0, n0k = 0, x1k = 0, n1k = 0;
    for (const s of samples) {
      if (!def.gate(s.actuals)) continue;
      const y = def.outcome(s.actuals) ? 1 : 0;
      if (s.ki) { n1i++; x1i += y; } else { n0i++; x0i += y; }
      if (s.ko) { n1k++; x1k += y; } else { n0k++; x0k += y; }
    }
    rows.push({ k, fam: family(k), ki: ztest(x0i, n0i, x1i, n1i), n1i, n0i, ko: ztest(x0k, n0k, x1k, n1k), n1k, n0k });
  }

  // ── PANEL representativo (los mercados que pediste) ──
  const panel = [
    'total_goals_over1_5', 'total_goals_over2_5', 'total_goals_under2_5', 'total_goals_over3_5', 'total_goals_under3_5',
    'home_goals_over1_5', 'home_goals_under1_5', 'away_goals_over1_5', 'away_goals_under1_5',
    'btts', 'btts_no', 'first_goal_45', 'goal_0_15', 'winner_1h_home', 'winner_1h_away',
    'total_cards_over2_5', 'total_cards_under2_5', 'total_corners_over4_5', 'total_corners_over8_5',
    'total_fouls_over2_5', 'total_shots_over4_5',
  ];
  const byKey = new Map(rows.map(r => [r.k, r]));
  console.log('\n══ PANEL key_injury=0 vs key_injury=1 (P(outcome) condicional) ══');
  console.log(`${'market'.padEnd(24)} ${'fam'.padEnd(13)} ${'ki=0'.padStart(7)} ${'ki=1'.padStart(7)} ${'Δ'.padStart(7)}  z      n(ki1)`);
  console.log('-'.repeat(78));
  for (const key of panel) {
    const r = byKey.get(key); if (!r || !r.ki) continue;
    console.log(`  ${key.padEnd(22)} ${r.fam.padEnd(13)} ${pct(r.ki.p0)} ${pct(r.ki.p1)} ${(r.ki.delta >= 0 ? '+' : '') + (100 * r.ki.delta).toFixed(1) + 'pp'} ${r.ki.z.toFixed(2).padStart(6)}${sig(r.ki.z)}  ${r.n1i}`);
  }

  // ── RESUMEN POR FAMILIA (ki) ──
  const summarize = (sel) => {
    const fams = {};
    for (const r of rows) {
      const t = r[sel]; if (!t) continue;
      const n1 = sel === 'ki' ? r.n1i : r.n1k, n0 = sel === 'ki' ? r.n0i : r.n0k;
      if (n1 < 50 || n0 < 50) continue; // potencia mínima
      const fa = (fams[r.fam] ||= { m: 0, sumAbsD: 0, sumAbsZ: 0, sigN: 0, maxD: 0, maxK: '' });
      fa.m++; fa.sumAbsD += Math.abs(t.delta); fa.sumAbsZ += Math.abs(t.z);
      if (Math.abs(t.z) >= 1.96) fa.sigN++;
      if (Math.abs(t.delta) > Math.abs(fa.maxD)) { fa.maxD = t.delta; fa.maxK = r.k; }
    }
    return Object.entries(fams)
      .map(([fam, v]) => ({ fam, ...v, meanAbsD: v.sumAbsD / v.m, meanAbsZ: v.sumAbsZ / v.m }))
      .sort((a, b) => b.meanAbsZ - a.meanAbsZ);
  };
  const printFam = (title, list) => {
    console.log(`\n══ ${title} (familias con ≥50 muestras por grupo) ══`);
    console.log(`${'familia'.padEnd(14)} ${'#mkt'.padStart(5)} ${'|Δ|medio'.padStart(9)} ${'|z|medio'.padStart(9)} ${'#sig'.padStart(5)}  mayor efecto`);
    console.log('-'.repeat(78));
    for (const f of list) {
      console.log(`  ${f.fam.padEnd(12)} ${String(f.m).padStart(5)} ${(100 * f.meanAbsD).toFixed(1).padStart(7)}pp ${f.meanAbsZ.toFixed(2).padStart(9)} ${String(f.sigN).padStart(5)}  ${f.maxK} (${(f.maxD >= 0 ? '+' : '') + (100 * f.maxD).toFixed(1)}pp)`);
    }
  };
  printFam('key_injury — RESUMEN POR FAMILIA', summarize('ki'));

  // Panel + familia para knockout.
  console.log('\n══ PANEL knockout=0 vs knockout=1 (P(outcome) condicional) ══');
  console.log(`${'market'.padEnd(24)} ${'fam'.padEnd(13)} ${'ko=0'.padStart(7)} ${'ko=1'.padStart(7)} ${'Δ'.padStart(7)}  z      n(ko1)`);
  console.log('-'.repeat(78));
  for (const key of panel) {
    const r = byKey.get(key); if (!r || !r.ko) continue;
    console.log(`  ${key.padEnd(22)} ${r.fam.padEnd(13)} ${pct(r.ko.p0)} ${pct(r.ko.p1)} ${(r.ko.delta >= 0 ? '+' : '') + (100 * r.ko.delta).toFixed(1) + 'pp'} ${r.ko.z.toFixed(2).padStart(6)}${sig(r.ko.z)}  ${r.n1k}`);
  }
  printFam('knockout — RESUMEN POR FAMILIA', summarize('ko'));

  console.log('\nLeyenda: Δ=p(señal=1)−p(señal=0) en puntos porcentuales · z test 2 prop (|z|≥1.96=*, 2.58=**, 3.29=***)');
  console.log('Lectura: si goles_* tienen |z| alto y tarjetas/corners/faltas ~0, el efecto direccional EXISTE');
  console.log('y la métrica de error agregada lo canceló/diluyó → toca modelos agregados POR FAMILIA direccionales.');

  await pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
