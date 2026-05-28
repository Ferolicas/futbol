/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Fase 6b — ENTRENA EL ML DESDE EL CRUDO (raw_api_payloads), NO desde
// match_predictions. Cada partido FINALIZADO del crudo es UNA muestra etiquetada
// con features POINT-IN-TIME (estado ANTERIOR a la fecha del partido → sin
// leakage). Eso da MILES de muestras vs las decenas viejas.
//
// ROL DEL ML (cambio de Fase 6b): ya NO decide la probabilidad — eso lo hace el
// motor de contexto con frecuencias reales (lib/context-engine). El ML es un
// DETECTOR DE RUPTURA: por mercado aprende P(outcome | contexto) desde el crudo;
// donde el contexto (forma, baja clave, eliminatoria, H2H…) hace que el mercado
// sea MENOS probable que su frecuencia base, eso alimenta el rupture_score del
// motor para degradar/vetar. Se guarda en prediction_models (model_type=
// 'rupture-logistic'); su aplicación en runtime va GATED por CONTEXT_ML_ENABLED.
//
//   node --env-file=.env scripts/train-meta-models.js
// También exportado trainMetaModels({pool?}) para el cron futbol-retrain.
// ────────────────────────────────────────────────────────────────────────
const { Pool } = require('pg');
const { MARKET_DEFS, predictWithModel } = require('../lib/meta-features');
const { recordFromRaw, computeMetrics, shrink, filterSegment, buildActuals, RATE_METRICS, ALL_METRICS, FINISHED } = require('../lib/adn');
const { meetingRecord, h2hForMarket } = require('../lib/h2h');

function makePool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 5,
  });
}

const MIN_SAMPLES = 200, VAL_FRACTION = 0.2, EPOCHS = 800, LR = 0.3, L2 = 0.02;
const PRIOR_RATE = 8, PRIOR_AVG = 6, RECENT_N = 6;
// Features DC-free del detector de ruptura (todas point-in-time).
const FEATURE_ORDER = ['adn_home', 'adn_away', 'home_ppg', 'away_ppg', 'knockout', 'key_injury', 'h2h_rate', 'h2h_n', 'exception_rate'];

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const clamp01 = (p) => Math.max(1e-6, Math.min(1 - 1e-6, p));
const logloss = (y, p) => { p = clamp01(p); return -(y * Math.log(p) + (1 - y) * Math.log(1 - p)); };
const round4 = (v) => v == null ? null : Math.round(v * 10000) / 10000;

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
    console.log('\n[train] Cargando crudo (fixtures/statistics/events/lineups/injuries/halfstats)…');
    const [{ rows: fxRows }, { rows: stRows }, { rows: evRows }, { rows: luRows }, { rows: injRows }, { rows: hsRows }] = await Promise.all([
      pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures'`),
      pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures/statistics'`),
      pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures/events'`),
      pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures/lineups'`),
      pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='injuries' AND sub_key LIKE 'fx:%'`),
      pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures/halfstats'`),
    ]);
    const stById = new Map(stRows.map(r => [Number(r.ref_id), r.payload]));
    const evById = new Map(evRows.map(r => [Number(r.ref_id), r.payload]));
    const injById = new Map(injRows.map(r => [Number(r.ref_id), r.payload]));
    const hsById = new Map(hsRows.map(r => [Number(r.ref_id), r.payload]));

    // Índices: fixtures por equipo (ordenados por fecha asc) + registros por liga (priors).
    const byTeam = new Map(), leagueRecs = new Map(), allRecs = [];
    for (const r of fxRows) {
      const f = r.payload;
      for (const tid of [f.teams?.home?.id, f.teams?.away?.id]) {
        if (!tid) continue;
        if (!byTeam.has(tid)) byTeam.set(tid, []); byTeam.get(tid).push(f);
        const rec = recordFromRaw(f, stById.get(Number(f?.fixture?.id)) || null, tid);
        if (rec) { allRecs.push(rec); if (rec.leagueId) { if (!leagueRecs.has(rec.leagueId)) leagueRecs.set(rec.leagueId, []); leagueRecs.get(rec.leagueId).push(rec); } }
      }
    }
    for (const arr of byTeam.values()) arr.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
    const globalPrior = computeMetrics(allRecs);
    const leaguePrior = new Map(); for (const [lid, recs] of leagueRecs) leaguePrior.set(lid, computeMetrics(recs));
    const priorVal = (lid, m) => leaguePrior.get(lid)?.[m]?.emp ?? globalPrior[m]?.emp ?? null;

    // ADN point-in-time (segmentos all/home/away) a fecha beforeMs.
    function ptADN(teamId, beforeMs) {
      const recs = (byTeam.get(teamId) || [])
        .filter(f => new Date(f.fixture.date).getTime() < beforeMs && FINISHED.has(f.fixture?.status?.short))
        .map(f => recordFromRaw(f, stById.get(Number(f.fixture.id)) || null, teamId)).filter(Boolean);
      const lidCount = {}; for (const r of recs) if (r.leagueId) lidCount[r.leagueId] = (lidCount[r.leagueId] || 0) + 1;
      const primaryLid = Number(Object.entries(lidCount).sort((a, b) => b[1] - a[1])[0]?.[0]) || null;
      const out = {};
      for (const seg of ['all', 'home', 'away']) {
        const mm = computeMetrics(filterSegment(recs, seg)); const o = {};
        for (const metric of ALL_METRICS) { const x = mm[metric]; if (!x) continue; const k = RATE_METRICS.includes(metric) ? PRIOR_RATE : PRIOR_AVG; o[metric] = { v: shrink(x.emp, x.n, priorVal(primaryLid, metric), k), n: x.n }; }
        out[seg] = o;
      }
      return out;
    }
    const adnVal = (adn, metric, seg) => { const m = (adn?.[seg] && adn[seg][metric]) || adn?.all?.[metric]; return m ? m.v : null; };

    // Puntos por partido (forma) de los últimos RECENT_N partidos antes de la fecha.
    function recentPPG(teamId, beforeMs) {
      const recs = (byTeam.get(teamId) || [])
        .filter(f => new Date(f.fixture.date).getTime() < beforeMs && FINISHED.has(f.fixture?.status?.short))
        .slice(-RECENT_N)
        .map(f => recordFromRaw(f, null, teamId)).filter(Boolean);
      if (!recs.length) return null;
      const pts = recs.reduce((s, r) => s + (r.result === 'W' ? 3 : r.result === 'D' ? 1 : 0), 0);
      return pts / recs.length / 3; // normalizado 0-1
    }

    // Cruces H2H point-in-time entre dos equipos (reconstruidos del crudo de fixtures).
    function meetingsFor(homeId, awayId, beforeMs) {
      const arr = (byTeam.get(homeId) || []).filter(f => {
        const h = f.teams?.home?.id, a = f.teams?.away?.id;
        const isPair = (h === homeId && a === awayId) || (h === awayId && a === homeId);
        return isPair && new Date(f.fixture.date).getTime() < beforeMs;
      });
      return arr.map(f => { const fid = Number(f.fixture.id); return meetingRecord(f, stById.get(fid) || null, evById.get(fid) || null, hsById.get(fid) || null); }).filter(Boolean);
    }

    // ── MUESTRAS: cada fixture FINALIZADO del crudo ──
    console.log('[train] Construyendo muestras desde el crudo…');
    const samplesBase = [];
    for (const r of fxRows) {
      const f = r.payload;
      if (!FINISHED.has(f.fixture?.status?.short)) continue;
      const homeId = f.teams?.home?.id, awayId = f.teams?.away?.id;
      if (!homeId || !awayId) continue;
      const fid = Number(f.fixture.id);
      const actuals = buildActuals(f, stById.get(fid) || null, evById.get(fid) || null, hsById.get(fid) || null);
      if (!actuals) continue;
      const beforeMs = new Date(f.fixture.date).getTime();
      const inj = injById.get(fid)?.response || injById.get(fid) || [];
      samplesBase.push({
        fid, homeId, awayId, beforeMs, actuals,
        homeADN: ptADN(homeId, beforeMs), awayADN: ptADN(awayId, beforeMs),
        homePPG: recentPPG(homeId, beforeMs), awayPPG: recentPPG(awayId, beforeMs),
        knockout: (actuals.phase === 'knockout' || actuals.phase === 'final') ? 1 : 0,
        keyInjury: (Array.isArray(inj) && inj.length > 0) ? 1 : 0,
        meetings: meetingsFor(homeId, awayId, beforeMs),
      });
    }
    console.log(`[train] Muestras (fixtures finalizados con datos): ${samplesBase.length}`);
    if (samplesBase.length < MIN_SAMPLES) {
      console.log('[train] Datos insuficientes.');
      return { source: 'raw', samples: samplesBase.length, trained: 0, activated: 0, skipped: 0, insufficient: true };
    }

    const allMarkets = Object.keys(MARKET_DEFS);
    let trained = 0, activated = 0, skipped = 0;
    const summary = [];

    for (const market of allMarkets) {
      const def = MARKET_DEFS[market];
      const samples = [];
      for (const sb of samplesBase) {
        if (!def.gate(sb.actuals)) continue;
        const h2h = h2hForMarket(sb.meetings, market, sb.homeId, sb.awayId, sb.beforeMs);
        const features = {
          adn_home: adnVal(sb.homeADN, def.homeMetric, 'home'),
          adn_away: adnVal(sb.awayADN, def.awayMetric, 'away'),
          home_ppg: sb.homePPG, away_ppg: sb.awayPPG,
          knockout: sb.knockout, key_injury: sb.keyInjury,
          h2h_rate: h2h.rate, h2h_n: Math.log1p(h2h.n || 0),
          exception_rate: h2h.n ? h2h.exceptions.length / h2h.n : null,
        };
        samples.push({ features, y: def.outcome(sb.actuals) ? 1 : 0 });
      }
      if (samples.length < MIN_SAMPLES) { skipped++; continue; }
      trained++;
      const cut = Math.floor(samples.length * (1 - VAL_FRACTION));
      const tr = samples.slice(0, cut), val = samples.slice(cut);
      const baseRate = clamp01(tr.reduce((s, x) => s + x.y, 0) / tr.length);
      const model = trainLogistic(tr);
      let mLL = 0, bLL = 0;
      for (const s of val) { const pm = predictWithModel(model, s.features); mLL += logloss(s.y, pm); bLL += logloss(s.y, baseRate); }
      const nv = val.length || 1; mLL /= nv; bLL /= nv;
      const beats = mLL < bLL;       // ¿supera predecir la tasa base constante?
      if (beats) activated++;
      const { rows: vr } = await pool.query(`SELECT COALESCE(MAX(version),0) v FROM prediction_models WHERE sport='football' AND market_key=$1`, [market]);
      await pool.query(`UPDATE prediction_models SET active=FALSE WHERE sport='football' AND market_key=$1`, [market]);
      await pool.query(
        `INSERT INTO prediction_models (sport,market_key,version,model_type,weights,metrics,active,trained_at)
         VALUES ('football',$1,$2,'rupture-logistic',$3::jsonb,$4::jsonb,$5,NOW())`,
        [market, vr[0].v + 1, JSON.stringify(model), JSON.stringify({ n: samples.length, n_val: nv, base_rate: round4(baseRate), logloss: round4(mLL), base_logloss: round4(bLL), beats_baseline: beats }), beats]
      );
      summary.push(`  ${market.padEnd(26)} n=${String(samples.length).padStart(5)}  LL=${mLL.toFixed(4)} base=${bLL.toFixed(4)}  ${beats ? '✓' : '·'}`);
    }

    console.log(summary.slice(0, 60).join('\n'));
    console.log(`\n══ RESUMEN (ML desde el crudo) ══`);
    console.log(`Muestras del crudo: ${samplesBase.length} · catálogo ${allMarkets.length} · entrenados ${trained} · activos ${activated} · skip ${skipped}`);
    return { source: 'raw', samples: samplesBase.length, catalog: allMarkets.length, trained, activated, skipped };
  } finally {
    if (ownPool) await pool.end();
  }
}

module.exports = { trainMetaModels };

if (require.main === module) {
  try { require('dotenv').config({ path: '.env.local' }); } catch {}
  try { require('dotenv').config({ path: '.env' }); } catch {}
  trainMetaModels()
    .then((r) => { console.log('\n[train] done:', JSON.stringify(r)); process.exit(0); })
    .catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
