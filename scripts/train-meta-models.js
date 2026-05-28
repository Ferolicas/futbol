/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Paso 3 — Entrena el meta-modelo (logística regularizada) por mercado (679),
// con ADN + H2H + excepciones POINT-IN-TIME (solo datos anteriores a la fecha
// de cada partido → SIN leakage). Split temporal, valida vs baseline (salida
// calibrada actual), activa solo los que superan en logloss. Versionado.
//
//   node --env-file=.env scripts/train-meta-models.js
//
// También exportado como trainMetaModels({ pool? }) para el cron nocturno de
// retrain (futbol-retrain).
// ────────────────────────────────────────────────────────────────────────
const { Pool } = require('pg');
const { buildMetaFeatures, predictWithModel, MARKET_DEFS, FEATURE_ORDER } = require('../lib/meta-features');
const { recordFromRaw, computeMetrics, shrink, filterSegment, RATE_METRICS, ALL_METRICS, FINISHED } = require('../lib/adn');
const { meetingRecord, h2hForMarket, exceptionCause, rupturePresentToday, modalXIFromLineups } = require('../lib/h2h');

function makePool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 5,
  });
}

const MIN_SAMPLES = 120, VAL_FRACTION = 0.2, EPOCHS = 900, LR = 0.3, L2 = 0.01;
const PRIOR_RATE = 8, PRIOR_AVG = 6;
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const clamp01 = (p) => Math.max(1e-6, Math.min(1 - 1e-6, p));
const logloss = (y, p) => { p = clamp01(p); return -(y * Math.log(p) + (1 - y) * Math.log(1 - p)); };
const round4 = (v) => v == null ? null : Math.round(v * 10000) / 10000;

// predictions_full o, si falta (filas viejas), sintetizado desde las columnas
// p_* legacy (mismo criterio que build-calibration.js). Cubre los mercados
// núcleo; los dinámicos solo existen en predictions_full → base null → skip.
function rowToPredictions(row) {
  if (row.predictions_full) return row.predictions_full;
  return {
    winner: { home: row.p_home_win, draw: row.p_draw, away: row.p_away_win },
    btts: row.p_btts, bttsNo: row.p_btts != null ? 100 - row.p_btts : null,
    overUnder: { over1_5: row.p_over_15, over2_5: row.p_over_25, over3_5: row.p_over_35 },
    corners: { over8_5: row.p_corners_over_85, over9_5: row.p_corners_over_95 },
    cards: { over2_5: row.p_cards_over_25, over3_5: row.p_cards_over_35, over4_5: row.p_cards_over_45 },
    firstGoal: { before30: row.p_first_goal_30, before45: row.p_first_goal_45 },
  };
}

function trainLogistic(samples) {
  const d = FEATURE_ORDER.length, means = {}, stds = {};
  for (const fn of FEATURE_ORDER) {
    const vals = samples.map(s => s.features[fn]).filter(v => v != null && isFinite(v));
    const m = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const va = vals.length ? vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length : 0;
    means[fn] = m; stds[fn] = Math.sqrt(va) || 1;
  }
  const X = samples.map(s => FEATURE_ORDER.map(fn => { const r = s.features[fn]; const v = (r == null || !isFinite(r)) ? means[fn] : r; return (v - means[fn]) / stds[fn]; }));
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
  const coefs = {}; FEATURE_ORDER.forEach((fn, j) => { coefs[fn] = w[j]; });
  return { bias: b, coefs, means, stds, features: FEATURE_ORDER };
}

async function trainMetaModels(opts = {}) {
  const { pool: extPool = null } = opts;
  const pool = extPool || makePool();
  const ownPool = !extPool;
  try {
  console.log('\nCargando crudos para ADN/H2H point-in-time…');
  const [{ rows: fxRows }, { rows: stRows }, { rows: h2hRows }, { rows: evRows }, { rows: luRows }, { rows: injRows }] = await Promise.all([
    pool.query(`SELECT ref_id,payload FROM raw_api_payloads WHERE endpoint='fixtures'`),
    pool.query(`SELECT ref_id,payload FROM raw_api_payloads WHERE endpoint='fixtures/statistics'`),
    pool.query(`SELECT ref_id,sub_key,payload FROM raw_api_payloads WHERE endpoint='fixtures/headtohead'`),
    pool.query(`SELECT ref_id,payload FROM raw_api_payloads WHERE endpoint='fixtures/events'`),
    pool.query(`SELECT ref_id,payload FROM raw_api_payloads WHERE endpoint='fixtures/lineups'`),
    pool.query(`SELECT ref_id,payload FROM raw_api_payloads WHERE endpoint='injuries' AND sub_key LIKE 'fx:%'`),
  ]);
  const stById = new Map(stRows.map(r => [Number(r.ref_id), r.payload]));
  const ctx = {
    events: Object.fromEntries(evRows.map(r => [Number(r.ref_id), r.payload])),
    lineups: Object.fromEntries(luRows.map(r => [Number(r.ref_id), r.payload])),
    injuries: Object.fromEntries(injRows.map(r => [Number(r.ref_id), r.payload])),
  };
  // Índices: fixtures por equipo (ordenados) + por liga + registros + meetings por par.
  const byTeam = new Map(), byLeague = new Map(), leagueRecs = new Map(), allRecs = [];
  const lineupsByTeam = new Map();
  for (const r of fxRows) {
    const f = r.payload, st = stById.get(Number(f?.fixture?.id)) || null;
    if (f.league?.id) { if (!byLeague.has(f.league.id)) byLeague.set(f.league.id, []); byLeague.get(f.league.id).push(f); }
    for (const tid of [f.teams?.home?.id, f.teams?.away?.id]) {
      if (!tid) continue;
      if (!byTeam.has(tid)) byTeam.set(tid, []); byTeam.get(tid).push(f);
      const rec = recordFromRaw(f, st, tid);
      if (rec) { allRecs.push(rec); if (rec.leagueId) { if (!leagueRecs.has(rec.leagueId)) leagueRecs.set(rec.leagueId, []); leagueRecs.get(rec.leagueId).push(rec); } }
    }
  }
  for (const arr of byTeam.values()) arr.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
  // modal XI por equipo (de todos los lineups disponibles).
  for (const r of luRows) { const arr = r.payload?.response || r.payload || []; for (const l of (Array.isArray(arr) ? arr : [])) { const tid = l.team?.id; if (!tid) continue; if (!lineupsByTeam.has(tid)) lineupsByTeam.set(tid, []); lineupsByTeam.get(tid).push(r.payload); } }
  const modalXI = new Map(); for (const [tid, lps] of lineupsByTeam) modalXI.set(tid, modalXIFromLineups(lps, tid));
  // meetings por par (min-max).
  const meetingsByPair = new Map();
  for (const r of h2hRows) {
    const a = Number(r.ref_id), b = Number(r.sub_key); const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    const ms = (r.payload?.response || []).map(f => meetingRecord(f, stById.get(Number(f?.fixture?.id)) || null)).filter(Boolean);
    meetingsByPair.set(key, ms);
  }
  // priors de liga (full-season; anclas poblacionales, no el target → uso permitido).
  const globalPrior = computeMetrics(allRecs);
  const leaguePrior = new Map(); for (const [lid, recs] of leagueRecs) leaguePrior.set(lid, computeMetrics(recs));
  const priorVal = (lid, m) => leaguePrior.get(lid)?.[m]?.emp ?? globalPrior[m]?.emp ?? null;

  // ADN point-in-time del equipo (segmentos all/home/away) a fecha beforeMs.
  function ptADN(teamId, beforeMs) {
    const recs = (byTeam.get(teamId) || [])
      .filter(f => new Date(f.fixture.date).getTime() < beforeMs && FINISHED.has(f.fixture?.status?.short))
      .map(f => recordFromRaw(f, stById.get(Number(f.fixture.id)) || null, teamId)).filter(Boolean);
    const lidCount = {}; for (const r of recs) if (r.leagueId) lidCount[r.leagueId] = (lidCount[r.leagueId] || 0) + 1;
    const primaryLid = Number(Object.entries(lidCount).sort((a, b) => b[1] - a[1])[0]?.[0]) || null;
    const out = {};
    for (const seg of ['all', 'home', 'away']) {
      const mm = computeMetrics(filterSegment(recs, seg)); const o = {};
      for (const metric of ALL_METRICS) { const x = mm[metric]; if (!x) continue; const k = RATE_METRICS.includes(metric) ? PRIOR_RATE : PRIOR_AVG; o[metric] = { shrunk_value: shrink(x.emp, x.n, priorVal(primaryLid, metric), k), sample_n: x.n, consistency: x.n / (x.n + k) }; }
      out[seg] = o;
    }
    return out;
  }

  console.log('Cargando match_predictions…');
  // NO exigimos predictions_full: los finalizados viejos (abr-may) son anteriores
  // a esa columna pero tienen las p_* legacy → rowToPredictions cae a ellas. Así
  // los mercados núcleo entrenan con todo el histórico, no solo los 8 recientes.
  const { rows: preds } = await pool.query(
    `SELECT fixture_id, kickoff, home_team, away_team, predictions_full, features_full, actuals_full,
            p_home_win, p_draw, p_away_win, p_btts,
            p_over_15, p_over_25, p_over_35,
            p_corners_over_85, p_corners_over_95,
            p_cards_over_25, p_cards_over_35, p_cards_over_45,
            p_first_goal_30, p_first_goal_45
     FROM match_predictions WHERE finalized_at IS NOT NULL AND features_full IS NOT NULL AND actuals_full IS NOT NULL
     ORDER BY kickoff ASC`);
  console.log(`Entrenables: ${preds.length}`);
  if (preds.length < MIN_SAMPLES) { console.log('Datos insuficientes.'); return { trainable: preds.length, trained: 0, activated: 0, skipped: 0, insufficient: true }; }

  // Base por muestra (ADN + meetings + contexto-hoy), reutilizable entre mercados.
  const base = preds.map(p => {
    const homeId = p.home_team?.id, awayId = p.away_team?.id, beforeMs = new Date(p.kickoff).getTime();
    const ff = p.features_full || {};
    const todayCtx = {
      knockout: !!ff.competition?.isKnockout,
      keyInjury: ((ff.state?.home?.injuryCount || 0) + (ff.state?.away?.injuryCount || 0)) > 0,
      rotationRisk: 0, earlyRedRisk: 0,
    };
    return {
      p, predsObj: rowToPredictions(p), homeId, awayId, beforeMs, ff,
      homeADN: ptADN(homeId, beforeMs), awayADN: ptADN(awayId, beforeMs),
      meetings: meetingsByPair.get(`${Math.min(homeId, awayId)}-${Math.max(homeId, awayId)}`) || [],
      todayCtx,
    };
  });

  const allMarkets = Object.keys(MARKET_DEFS);
  console.log(`Catálogo: ${allMarkets.length} mercados\n`);
  const summary = []; let trained = 0, activated = 0, skipped = 0;

  for (const market of allMarkets) {
    const def = MARKET_DEFS[market];
    const samples = [];
    for (const sb of base) {
      if (!def.gate(sb.p.actuals_full)) continue;
      const h2h = h2hForMarket(sb.meetings, market, sb.homeId, sb.awayId, sb.beforeMs);
      // Nivel 3: causa de las excepciones + ¿presente hoy?
      let ruptureToday = 0;
      if (h2h.exceptions.length) {
        const agg = { earlyRed: false, knockout: false, rotation: false, keyInjury: false };
        for (const ex of h2h.exceptions) {
          const c = exceptionCause(ex.fixtureId, ctx, sb.homeId, modalXI.get(sb.homeId));
          for (const k of Object.keys(agg)) agg[k] = agg[k] || c[k];
        }
        ruptureToday = rupturePresentToday(agg, sb.todayCtx);
      }
      const causal = { exceptionRate: h2h.n ? h2h.exceptions.length / h2h.n : null, ruptureToday, rotationRisk: 0 };
      const mf = buildMetaFeatures({ featuresFull: sb.ff, predictionsFull: sb.predsObj, homeProfile: sb.homeADN, awayProfile: sb.awayADN, market, h2h, causal });
      if (!mf) continue;
      samples.push({ features: mf.features, base: mf.base, y: def.outcome(sb.p.actuals_full) ? 1 : 0 });
    }
    if (samples.length < MIN_SAMPLES) { skipped++; continue; }
    trained++;
    const cut = Math.floor(samples.length * (1 - VAL_FRACTION));
    const tr = samples.slice(0, cut), val = samples.slice(cut);
    const model = trainLogistic(tr);
    let mLL = 0, bLL = 0, mBr = 0, bBr = 0;
    for (const s of val) { const pm = predictWithModel(model, s.features); mLL += logloss(s.y, pm); bLL += logloss(s.y, s.base); mBr += (pm - s.y) ** 2; bBr += (s.base - s.y) ** 2; }
    const nv = val.length; mLL /= nv; bLL /= nv; mBr /= nv; bBr /= nv;
    const beats = mLL < bLL;
    if (beats) activated++;
    const { rows: vr } = await pool.query(`SELECT COALESCE(MAX(version),0) v FROM prediction_models WHERE sport='football' AND market_key=$1`, [market]);
    await pool.query(`UPDATE prediction_models SET active=FALSE WHERE sport='football' AND market_key=$1`, [market]);
    await pool.query(
      `INSERT INTO prediction_models (sport,market_key,version,model_type,weights,metrics,active,trained_at)
       VALUES ('football',$1,$2,'logistic',$3::jsonb,$4::jsonb,$5,NOW())`,
      [market, vr[0].v + 1, JSON.stringify(model), JSON.stringify({ n: samples.length, n_val: nv, logloss: round4(mLL), brier: round4(mBr), base_logloss: round4(bLL), base_brier: round4(bBr), beats_baseline: beats }), beats]
    );
    summary.push(`  ${market.padEnd(26)} n=${String(samples.length).padStart(4)}  LL meta=${mLL.toFixed(4)} base=${bLL.toFixed(4)}  Brier meta=${mBr.toFixed(4)} base=${bBr.toFixed(4)}  ${beats ? '✓ ACTIVO' : '·'}`);
  }

  console.log('Mercados entrenados:'); console.log(summary.join('\n'));
  console.log(`\n══ RESUMEN ══`);
  console.log(`Catálogo ${allMarkets.length} · entrenados ${trained} · ACTIVOS ${activated} · skip ${skipped}`);
  console.log('✓ prediction_models actualizado (active = supera baseline).');
  return { catalog: allMarkets.length, trainable: preds.length, trained, activated, skipped };
  } finally {
    if (ownPool) await pool.end();
  }
}

module.exports = { trainMetaModels };

if (require.main === module) {
  try { require('dotenv').config({ path: '.env.local' }); } catch {}
  try { require('dotenv').config({ path: '.env' }); } catch {}
  trainMetaModels()
    .then(() => process.exit(0))
    .catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
