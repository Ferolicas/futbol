/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Fase 6b — ENTRENA EL ML (detector de ruptura) DESDE EL CRUDO (raw_api_payloads).
// Cada fixture FINALIZADO es UNA muestra con features POINT-IN-TIME (estado
// ANTERIOR a la fecha → sin leakage). Miles de muestras vs decenas.
//
// PARIDAD train↔runtime: usa el MISMO builder de features que el motor
// (lib/context-engine: ruptureContext + buildRuptureFeatures, ADN empírico crudo,
// Opción A sin shrink). Por mercado entrena una logística que predice
// P(outcome|contexto); se guarda en prediction_models (model_type='rupture-logistic'),
// activa si supera predecir la tasa base. Rol: detector de ruptura que modula el
// rupture_score del motor (runtime gated por CONTEXT_ML_ENABLED).
//
//   node --env-file=.env scripts/train-meta-models.js
// También exportado trainMetaModels({pool?}) para el cron futbol-retrain.
// ────────────────────────────────────────────────────────────────────────
const { Pool } = require('pg');
const { MARKET_DEFS, predictWithModel } = require('../lib/meta-features');
const { recordFromRaw, buildActuals, FINISHED } = require('../lib/adn');
const { meetingRecord, modalXIFromLineups } = require('../lib/h2h');
const { ruptureContext, buildRuptureFeatures, isKeyInjury, ML_FEATURE_ORDER, marketGroup } = require('../lib/context-engine');

function makePool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 5,
  });
}

const MIN_SAMPLES = 200, VAL_FRACTION = 0.2, EPOCHS = 800, LR = 0.3, L2 = 0.02;
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const clamp01 = (p) => Math.max(1e-6, Math.min(1 - 1e-6, p));
const logloss = (y, p) => { p = clamp01(p); return -(y * Math.log(p) + (1 - y) * Math.log(1 - p)); };
const round4 = (v) => v == null ? null : Math.round(v * 10000) / 10000;

// ── Modelos DIRECCIONALES por familia+sentido ──
// Constantes: tamaño mínimo de la celda base (ki=0,ko=0) por mercado para tener
// offset estable; exposición mínima de la señal en el grupo para confiar en β.
const FAM_MIN_CELL = 30, FAM_MIN_EXPO = 200, FAM_EPOCHS = 3000, FAM_LR = 1.0, FAM_L2 = 0.002;
// Logística binomial AGRUPADA con offset por mercado: estima βki, βko (mismo signo
// dentro del grupo, no se cancelan). rows = [{off, cells[ki][ko]={n,y}}].
function fitGroupShift(rows) {
  let bki = 0, bko = 0;
  for (let ep = 0; ep < FAM_EPOCHS; ep++) {
    let gki = 0, gko = 0, N = 0;
    for (const r of rows) {
      for (let ki = 0; ki < 2; ki++) for (let ko = 0; ko < 2; ko++) {
        const c = r.cells[ki][ko]; if (!c.n) continue;
        const p = sigmoid(r.off + bki * ki + bko * ko);
        const resid = c.n * p - c.y; // gradiente binomial agrupado
        gki += resid * ki; gko += resid * ko; N += c.n;
      }
    }
    if (!N) break;
    bki -= FAM_LR * (gki / N + FAM_L2 * bki);
    bko -= FAM_LR * (gko / N + FAM_L2 * bko);
  }
  return { bki, bko };
}

function trainLogistic(samples, F = ML_FEATURE_ORDER) {
  const d = F.length, means = {}, stds = {};
  for (const fn of F) {
    const vals = samples.map(s => s.features[fn]).filter(v => v != null && isFinite(v));
    const m = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const va = vals.length ? vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length : 0;
    means[fn] = m; stds[fn] = Math.sqrt(va) || 1;
  }
  const X = samples.map(s => F.map(fn => { const r = s.features[fn]; const v = (r == null || !isFinite(r)) ? means[fn] : r; return (v - means[fn]) / stds[fn]; }));
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

    // XI habitual (modal XI) por equipo desde los lineups → para key_injury.
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

    // Fixtures por equipo (ordenados por fecha asc).
    const byTeam = new Map();
    for (const r of fxRows) {
      const f = r.payload;
      for (const tid of [f.teams?.home?.id, f.teams?.away?.id]) {
        if (!tid) continue;
        if (!byTeam.has(tid)) byTeam.set(tid, []); byTeam.get(tid).push(f);
      }
    }
    for (const arr of byTeam.values()) arr.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

    // Records por equipo (recordFromRaw) — cacheados; el builder filtra point-in-time.
    const teamRecCache = new Map();
    const teamRecords = (teamId) => {
      if (teamRecCache.has(teamId)) return teamRecCache.get(teamId);
      const recs = (byTeam.get(teamId) || []).map(f => recordFromRaw(f, stById.get(Number(f.fixture.id)) || null, teamId)).filter(Boolean);
      teamRecCache.set(teamId, recs); return recs;
    };
    // Cruces de un par (reconstruidos del crudo; el builder/h2hForMarket filtra <beforeMs).
    const meetingsFor = (homeId, awayId) => (byTeam.get(homeId) || [])
      .filter(f => { const h = f.teams?.home?.id, a = f.teams?.away?.id; return (h === homeId && a === awayId) || (h === awayId && a === homeId); })
      .map(f => { const fid = Number(f.fixture.id); return meetingRecord(f, stById.get(fid) || null, evById.get(fid) || null, hsById.get(fid) || null); })
      .filter(Boolean);

    // ── MUESTRAS: cada fixture finalizado → label + rc (contexto precomputado) ──
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
      const todayCtx = {
        knockout: (actuals.phase === 'knockout' || actuals.phase === 'final'),
        // MISMO criterio que runtime: ¿lesionado del XI habitual de su equipo?
        keyInjury: isKeyInjury(injById.get(fid), modalXIByTeam),
      };
      const rc = ruptureContext({ homeTeamRecords: teamRecords(homeId), awayTeamRecords: teamRecords(awayId), todayCtx, beforeMs });
      samplesBase.push({ homeId, awayId, beforeMs, actuals, rc, meetings: meetingsFor(homeId, awayId) });
    }
    console.log(`[train] Muestras (fixtures finalizados con datos): ${samplesBase.length}`);
    if (samplesBase.length < MIN_SAMPLES) {
      console.log('[train] Datos insuficientes.');
      return { source: 'raw', samples: samplesBase.length, trained: 0, activated: 0, skipped: 0, insufficient: true };
    }

    const allMarkets = Object.keys(MARKET_DEFS);
    console.log(`[train] Catálogo: ${allMarkets.length} mercados · entrenando…`);
    let trained = 0, activated = 0, skipped = 0, processed = 0;
    const t0 = Date.now();
    // Buckets para los modelos direccionales por familia+sentido (offset por mercado).
    const groupBuckets = new Map();

    for (const market of allMarkets) {
      const def = MARKET_DEFS[market];
      const samples = [];
      for (const sb of samplesBase) {
        if (!def.gate(sb.actuals)) continue;
        const features = buildRuptureFeatures({ def, market, rc: sb.rc, meetings: sb.meetings, homeId: sb.homeId, awayId: sb.awayId, beforeMs: sb.beforeMs });
        samples.push({ features, y: def.outcome(sb.actuals) ? 1 : 0, sb });
      }
      // Tabla de contingencia 2×2 (ki × ko) del mercado → alimenta su grupo
      // direccional. Offset = log-odds de la celda base (ki=0,ko=0) del mercado.
      {
        const cells = [[{ n: 0, y: 0 }, { n: 0, y: 0 }], [{ n: 0, y: 0 }, { n: 0, y: 0 }]];
        for (const s of samples) {
          const ki = s.sb.rc.key_injury ? 1 : 0, ko = s.sb.rc.knockout ? 1 : 0;
          cells[ki][ko].n++; cells[ki][ko].y += s.y;
        }
        const base = cells[0][0];
        if (base.n >= FAM_MIN_CELL) {
          const base0 = clamp01(base.y / base.n);
          const g = marketGroup(market);
          if (!groupBuckets.has(g)) groupBuckets.set(g, []);
          groupBuckets.get(g).push({ off: Math.log(base0 / (1 - base0)), cells });
        }
      }
      // Progreso cada 100 mercados (para que la corrida no parezca colgada).
      if (++processed % 100 === 0) console.log(`  …${processed}/${allMarkets.length} mercados · entrenados=${trained} activos=${activated} · ${Math.round((Date.now() - t0) / 1000)}s`);
      if (samples.length < MIN_SAMPLES) { skipped++; continue; }
      trained++;
      const cut = Math.floor(samples.length * (1 - VAL_FRACTION));
      const tr = samples.slice(0, cut), val = samples.slice(cut);
      const baseRate = clamp01(tr.reduce((s, x) => s + x.y, 0) / tr.length);
      const model = trainLogistic(tr);
      let mLL = 0, bLL = 0;
      for (const s of val) { const pm = predictWithModel(model, s.features); mLL += logloss(s.y, pm); bLL += logloss(s.y, baseRate); }
      const nv = val.length || 1; mLL /= nv; bLL /= nv;
      const beats = mLL < bLL;
      if (beats) activated++;
      const { rows: vr } = await pool.query(`SELECT COALESCE(MAX(version),0) v FROM prediction_models WHERE sport='football' AND market_key=$1`, [market]);
      await pool.query(`UPDATE prediction_models SET active=FALSE WHERE sport='football' AND market_key=$1`, [market]);
      await pool.query(
        `INSERT INTO prediction_models (sport,market_key,version,model_type,weights,metrics,active,trained_at)
         VALUES ('football',$1,$2,'rupture-logistic',$3::jsonb,$4::jsonb,$5,NOW())`,
        [market, vr[0].v + 1, JSON.stringify(model), JSON.stringify({ n: samples.length, n_val: nv, base_rate: round4(baseRate), logloss: round4(mLL), base_logloss: round4(bLL), beats_baseline: beats }), beats]
      );
    }

    // ── MODELOS DIRECCIONALES por FAMILIA+SENTIDO (key_injury / knockout) ──
    // Por grupo (familia+sentido) estimamos el desplazamiento de log-odds CON SIGNO.
    // Mercados del mismo grupo se mueven igual → no se cancelan (a diferencia del
    // error agregado). Solo confiamos en β si hay exposición suficiente de la señal.
    await pool.query(`UPDATE prediction_models SET active=FALSE WHERE sport='football' AND model_type='family-directional'`);
    let famStored = 0; const famTop = [];
    for (const [group, rows] of groupBuckets) {
      let nki = 0, nko = 0, nbase = 0;
      for (const r of rows) {
        nki += r.cells[1][0].n + r.cells[1][1].n;
        nko += r.cells[0][1].n + r.cells[1][1].n;
        nbase += r.cells[0][0].n;
      }
      if (nki < FAM_MIN_EXPO && nko < FAM_MIN_EXPO) continue; // sin señal suficiente
      const { bki, bko } = fitGroupShift(rows);
      // Anula el coef de la señal sin exposición mínima (no inventamos efecto).
      const ki = nki >= FAM_MIN_EXPO ? round4(bki) : 0;
      const ko = nko >= FAM_MIN_EXPO ? round4(bko) : 0;
      if (ki === 0 && ko === 0) continue;
      // pp de desplazamiento en p=0.5 (referencia legible).
      const ppKi = round4(sigmoid(ki) - 0.5), ppKo = round4(sigmoid(ko) - 0.5);
      const { rows: gv } = await pool.query(`SELECT COALESCE(MAX(version),0) v FROM prediction_models WHERE sport='football' AND market_key=$1`, [group]);
      await pool.query(
        `INSERT INTO prediction_models (sport,market_key,version,model_type,weights,metrics,active,trained_at)
         VALUES ('football',$1,$2,'family-directional',$3::jsonb,$4::jsonb,TRUE,NOW())`,
        [group, gv[0].v + 1, JSON.stringify({ ki, ko }), JSON.stringify({ markets: rows.length, n_ki: nki, n_ko: nko, n_base: nbase, shift_ki_pp_at50: ppKi, shift_ko_pp_at50: ppKo })]
      );
      famStored++;
      famTop.push({ group, ki, ko, ppKi, ppKo, nki, nko });
    }
    famTop.sort((a, b) => (Math.abs(b.ki) + Math.abs(b.ko)) - (Math.abs(a.ki) + Math.abs(a.ko)));
    console.log(`\n[train] Modelos DIRECCIONALES por familia: ${famStored} grupos guardados (de ${groupBuckets.size})`);
    for (const f of famTop.slice(0, 15)) {
      console.log(`  ${f.group.padEnd(22)} βki=${String(f.ki).padStart(8)} (${f.ppKi >= 0 ? '+' : ''}${(100 * f.ppKi).toFixed(1)}pp)  βko=${String(f.ko).padStart(8)} (${f.ppKo >= 0 ? '+' : ''}${(100 * f.ppKo).toFixed(1)}pp)  nki=${f.nki} nko=${f.nko}`);
    }

    console.log(`\n══ RESUMEN (ML desde el crudo) ══`);
    console.log(`Muestras del crudo: ${samplesBase.length} · catálogo ${allMarkets.length} · entrenados ${trained} · activos ${activated} · skip ${skipped} · familias direccionales ${famStored} · ${Math.round((Date.now() - t0) / 1000)}s`);
    return {
      source: 'raw', samples: samplesBase.length, catalog: allMarkets.length, trained, activated, skipped,
      family_models: famStored,
    };
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
