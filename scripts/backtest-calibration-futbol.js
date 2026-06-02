/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────────
// Backtest de CALIBRACIÓN del motor de contexto (READ-ONLY, solo SELECT).
//
// Reproduce cada fixture finalizado POINT-IN-TIME (solo con datos ANTERIORES a su
// fecha, sin fuga) a través del MISMO motor (computeContext + scoreContext) y
// compara la prob_final con el RESULTADO REAL (MARKET_DEFS.outcome).
//
// Reporta, por familia de mercado, la CURVA DE FIABILIDAD: cuando el modelo dice
// "X%", ¿de verdad acierta X%? + Brier, log-loss, ECE (error de calibración) y
// la tasa base. Un "gap +" = SOBRECONFIADO (el "99% par" se vería en el bucket
// 90-100% con tasa real muy por debajo).
//
// Es la PUERTA DE APROBACIÓN: se corre antes y después de cada cambio (shrink,
// distribución coherente, recencia) para ver el antes/después con NÚMEROS.
// NO escribe nada. Uso:
//   node --env-file=.env scripts/backtest-calibration-futbol.js [--ml] [--family=goles_total]
// ────────────────────────────────────────────────────────────────────────────
const { Pool } = require('pg');
const { MARKET_DEFS } = require('../lib/meta-features');
const { recordFromRaw, buildActuals, FINISHED } = require('../lib/adn');
const { meetingRecord, modalXIFromLineups } = require('../lib/h2h');
const { computeContext, scoreContext, isKeyInjury, marketFamily, rateFromRecords, SHRINK_K_BY_FAMILY } = require('../lib/context-engine');

const args = process.argv.slice(2);
const USE_ML = args.includes('--ml');
const ONLY_FAM = (args.find(a => a.startsWith('--family=')) || '').split('=')[1] || null;
// --shrink: aplica shrink bayesiano hacia la tasa base del mercado, ponderado por
// muestra: p_shrunk = (n·p + k·base)/(n+k). k = fuerza del prior (cuántos partidos
// "ficticios" en la base). Reporta raw vs shrunk lado a lado para tunear k SIN
// tocar runtime. k puede ser por-familia: --k=8 global, o defaults internos.
const USE_SHRINK = args.includes('--shrink');
const K_GLOBAL = Number((args.find(a => a.startsWith('--k=')) || '').split('=')[1]) || null;
// --recency: pondera el ADN (L2) por antigüedad — partidos recientes pesan más.
// Peso = 0.5^(díasDeAntigüedad / halfLife). --hl=N fija la vida media en días
// (default 180). refMs = fecha del fixture (point-in-time). El H2H (L1) NO se
// pondera (la historia mutua es atemporal). Mide el efecto sobre la calibración.
const USE_RECENCY = args.includes('--recency');
const RECENCY_HALFLIFE = Number((args.find(a => a.startsWith('--hl=')) || '').split('=')[1]) || 180;
// Defaults por familia (categóricos = shrink fuerte; conteo = suave). Override con --k.
// El shrink REAL lo aplica scoreContext (lib/context-engine) con SHRINK_K_BY_FAMILY.
// Aquí solo se usa para la ETIQUETA del reporte → importado para que no derive.
const K_BY_FAMILY = SHRINK_K_BY_FAMILY;
const kFor = (fam) => K_GLOBAL != null ? K_GLOBAL : (K_BY_FAMILY[fam] ?? 5);

function makePool() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL no definida'); process.exit(1); }
  return new Pool({ connectionString: url, max: 4 });
}

async function main() {
  const pool = makePool();
  console.log('[backtest] cargando crudo (read-only)…');
  const [{ rows: fxRows }, { rows: stRows }, { rows: evRows }, { rows: luRows }, { rows: injRows }, { rows: hsRows }] = await Promise.all([
    pool.query(`SELECT ref_id,payload FROM raw_api_payloads WHERE endpoint='fixtures'`),
    pool.query(`SELECT ref_id,payload FROM raw_api_payloads WHERE endpoint='fixtures/statistics'`),
    pool.query(`SELECT ref_id,payload FROM raw_api_payloads WHERE endpoint='fixtures/events'`),
    pool.query(`SELECT ref_id,payload FROM raw_api_payloads WHERE endpoint='fixtures/lineups'`),
    pool.query(`SELECT ref_id,payload FROM raw_api_payloads WHERE endpoint='injuries' AND sub_key LIKE 'fx:%'`),
    pool.query(`SELECT ref_id,payload FROM raw_api_payloads WHERE endpoint='fixtures/halfstats'`),
  ]);
  const stById = new Map(stRows.map(r => [Number(r.ref_id), r.payload]));
  const evById = new Map(evRows.map(r => [Number(r.ref_id), r.payload]));
  const injById = new Map(injRows.map(r => [Number(r.ref_id), r.payload]));
  const hsById = new Map(hsRows.map(r => [Number(r.ref_id), r.payload]));

  const lineupsByTeam = new Map();
  for (const r of luRows) { const arr = r.payload?.response || r.payload || []; for (const l of (Array.isArray(arr) ? arr : [])) { const tid = l.team?.id; if (!tid) continue; if (!lineupsByTeam.has(tid)) lineupsByTeam.set(tid, []); lineupsByTeam.get(tid).push(r.payload); } }
  const modalXIByTeam = new Map();
  for (const [tid, p] of lineupsByTeam) modalXIByTeam.set(tid, modalXIFromLineups(p, tid));

  const byTeam = new Map();
  for (const r of fxRows) { const f = r.payload; for (const tid of [f.teams?.home?.id, f.teams?.away?.id]) { if (!tid) continue; if (!byTeam.has(tid)) byTeam.set(tid, []); byTeam.get(tid).push(f); } }
  for (const arr of byTeam.values()) arr.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

  const recCache = new Map();
  const teamRecords = (tid) => { if (recCache.has(tid)) return recCache.get(tid); const recs = (byTeam.get(tid) || []).map(f => recordFromRaw(f, stById.get(Number(f.fixture.id)) || null, tid)).filter(Boolean); recCache.set(tid, recs); return recs; };
  const meetingsPIT = (h, a, beforeMs) => (byTeam.get(h) || [])
    .filter(f => { const H = f.teams?.home?.id, A = f.teams?.away?.id; return ((H === h && A === a) || (H === a && A === h)) && new Date(f.fixture.date).getTime() < beforeMs; })
    .map(f => { const fid = Number(f.fixture.id); return meetingRecord(f, stById.get(fid) || null, evById.get(fid) || null, hsById.get(fid) || null); }).filter(Boolean);

  const fam = {};
  const ensure = (f) => { if (!fam[f]) fam[f] = { buckets: Array.from({ length: 10 }, () => ({ sp: 0, sy: 0, n: 0 })), brier: 0, ll: 0, n: 0, sumy: 0 }; return fam[f]; };
  const famShrunk = {};
  const ensureS = (f) => { if (!famShrunk[f]) famShrunk[f] = { buckets: Array.from({ length: 10 }, () => ({ sp: 0, sy: 0, n: 0 })), brier: 0, ll: 0, n: 0, sumy: 0 }; return famShrunk[f]; };
  const c01 = (p) => Math.max(1e-6, Math.min(1 - 1e-6, p));

  // Actuals REALES de cada fixture terminado (buildActuals = la misma definición
  // que evalúa el motor y la familia). Se precomputa una vez y se reusa para
  // (a) la tasa base del shrink y (b) el bucle de evaluación. Read-only.
  const actualsByFid = new Map();
  for (const r of fxRows) {
    const f = r.payload;
    if (!FINISHED.has(f.fixture?.status?.short)) continue;
    const fid = Number(f.fixture?.id); if (!fid) continue;
    const a = buildActuals(f, stById.get(fid) || null, evById.get(fid) || null, hsById.get(fid) || null);
    if (a) actualsByFid.set(fid, a);
  }

  // Records POR EQUIPO en shape de RUNTIME ({venue, actuals, date}) — igual que
  // loadContextInputs.recOf. IMPRESCINDIBLE: hace que L2 (ADN) dispare en el
  // backtest como en producción (rateFromRecords lee r.actuals). Antes se pasaban
  // records recordFromRaw planos (sin .actuals) → L2 nunca disparaba → el backtest
  // solo medía L1/H2H. Ahora mide el path completo L1+L2 del runtime.
  const recAxCache = new Map();
  const teamActualsRecords = (tid) => {
    if (recAxCache.has(tid)) return recAxCache.get(tid);
    const recs = (byTeam.get(tid) || []).map(f => {
      const fid = Number(f.fixture.id); const a = actualsByFid.get(fid); if (!a) return null;
      return { venue: f.teams?.home?.id === tid ? 'home' : 'away', actuals: a, date: f.fixture?.date };
    }).filter(Boolean);
    recAxCache.set(tid, recs);
    return recs;
  };

  // Tasa base por mercado (prior del shrink) = frecuencia REAL del mercado sobre
  // TODOS los fixtures terminados, medida con el MISMO def.gate/outcome del
  // backtest. Es por-CLAVE, no por-familia: cada línea tiene su propia base
  // (Over0.5≈0.95, Over3.5≈0.25, gana local≈0.45, empate≈0.27…). Encoger hacia
  // ESTA base — y no hacia 0.5 — es lo que calibra sin romper los conteos. R-O.
  const baseRate = {};
  if (USE_SHRINK) {
    const MIN_BASE_N = 50; // muestra mínima para un prior estable
    for (const key of Object.keys(MARKET_DEFS)) {
      const def = MARKET_DEFS[key]; let n = 0, hits = 0;
      for (const a of actualsByFid.values()) { if (!def.gate(a)) continue; n++; if (def.outcome(a)) hits++; }
      if (n >= MIN_BASE_N) baseRate[key] = hits / n;
    }
    console.log(`[backtest] shrink ON · tasas base de ${Object.keys(baseRate).length} mercados (sobre ${actualsByFid.size} fixtures terminados) · k=${K_GLOBAL != null ? K_GLOBAL : 'por-familia'}`);
  }

  let nFix = 0;
  for (const r of fxRows) {
    const f = r.payload;
    if (!FINISHED.has(f.fixture?.status?.short)) continue;
    const homeId = f.teams?.home?.id, awayId = f.teams?.away?.id; if (!homeId || !awayId) continue;
    const fid = Number(f.fixture.id);
    const actuals = actualsByFid.get(fid);
    if (!actuals) continue;
    const beforeMs = new Date(f.fixture.date).getTime();
    const pit = (recs) => recs.filter(x => x && x.date && new Date(x.date).getTime() < beforeMs);
    const homeRecs = pit(teamActualsRecords(homeId)), awayRecs = pit(teamActualsRecords(awayId));
    const meetings = meetingsPIT(homeId, awayId, beforeMs);
    if (!homeRecs.length && !awayRecs.length && !meetings.length) continue;
    const recency = USE_RECENCY ? { halfLifeDays: RECENCY_HALFLIFE, refMs: beforeMs } : null;
    const ctxOut = computeContext({ homeId, awayId, meetings, homeRecords: homeRecs, awayRecords: awayRecs, recency });
    if (!Object.keys(ctxOut).length) continue;
    const todayCtx = { knockout: (actuals.phase === 'knockout' || actuals.phase === 'final'), keyInjury: isKeyInjury(injById.get(fid), modalXIByTeam) };
    // baseRates → scoreContext aplica el shrink INTERNAMENTE (path REAL de runtime).
    // Expone prob_final (calibrado) y prob_final_raw (sin shrink) → medimos ambos
    // de UNA sola corrida, sin math externa que pueda divergir del motor.
    const scored = scoreContext(ctxOut, { meetings, ctx: {}, modalXIByTeam, todayCtx, homeId, awayId, homeRecords: homeRecs, awayRecords: awayRecs, homeTeamRecords: teamRecords(homeId), awayTeamRecords: teamRecords(awayId), mlEnabled: USE_ML, baseRates: USE_SHRINK ? baseRate : null, shrinkK: K_GLOBAL });
    nFix++;
    for (const [key, sc] of Object.entries(scored)) {
      const def = MARKET_DEFS[key]; if (!def) continue;
      if (!def.gate(actuals)) continue;
      const pf = sc.prob_final; if (pf == null || !isFinite(pf)) continue;
      const ff = marketFamily(key); if (ONLY_FAM && ff !== ONLY_FAM) continue;
      const y = def.outcome(actuals) ? 1 : 0;
      const praw = (sc.prob_final_raw != null && isFinite(sc.prob_final_raw)) ? sc.prob_final_raw : pf;
      const F = ensure(ff);
      const bi = Math.min(9, Math.max(0, Math.floor(praw * 10)));
      F.buckets[bi].sp += praw; F.buckets[bi].sy += y; F.buckets[bi].n++;
      F.brier += (praw - y) * (praw - y); F.ll += -(y * Math.log(c01(praw)) + (1 - y) * Math.log(1 - c01(praw))); F.n++; F.sumy += y;
      if (USE_SHRINK) {
        const S = ensureS(ff);
        const bj = Math.min(9, Math.max(0, Math.floor(pf * 10)));
        S.buckets[bj].sp += pf; S.buckets[bj].sy += y; S.buckets[bj].n++;
        S.brier += (pf - y) * (pf - y); S.ll += -(y * Math.log(c01(pf)) + (1 - y) * Math.log(1 - c01(pf))); S.n++; S.sumy += y;
      }
    }
  }

  console.log(`\n[backtest] fixtures evaluados: ${nFix} · ML: ${USE_ML ? 'ON' : 'off (motor empírico base)'}${USE_SHRINK ? ' · SHRINK ON' : ''}${USE_RECENCY ? ` · RECENCY ON (hl=${RECENCY_HALFLIFE}d)` : ''} · L1+L2\n`);
  const eceOf = (F) => { let e = 0; for (const b of F.buckets) { if (b.n) e += (b.n / F.n) * Math.abs(b.sp / b.n - b.sy / b.n); } return e; };
  const fams = Object.keys(fam).sort();
  let gBrier = 0, gN = 0, gECE = 0, gBrierS = 0, gECES = 0;
  for (const ff of fams) {
    const F = fam[ff]; if (!F.n) continue;
    const brier = F.brier / F.n, ll = F.ll / F.n, base = F.sumy / F.n, ece = eceOf(F);
    gBrier += F.brier; gN += F.n; gECE += ece * F.n;
    if (USE_SHRINK && famShrunk[ff]) {
      const S = famShrunk[ff], eceS = eceOf(S);
      gBrierS += S.brier; gECES += eceS * S.n;
      console.log(`── ${ff}  n=${F.n} base=${(base * 100).toFixed(1)}%  | RAW: Brier ${brier.toFixed(3)} ECE ${(ece * 100).toFixed(1)}%  →  SHRUNK(k=${kFor(ff)}): Brier ${(S.brier / S.n).toFixed(3)} ECE ${(eceS * 100).toFixed(1)}%`);
      for (let i = 0; i < 10; i++) { const b = S.buckets[i]; if (!b.n) continue; const pred = b.sp / b.n * 100, act = b.sy / b.n * 100, gap = pred - act; console.log(`     shrunk[${String(i * 10).padStart(2)}-${i * 10 + 10}%] pred ${pred.toFixed(0).padStart(3)}%  real ${act.toFixed(0).padStart(3)}%  n=${String(b.n).padStart(5)}  gap ${gap >= 0 ? '+' : ''}${gap.toFixed(0)}${Math.abs(gap) >= 10 ? '  <- aún desfase' : ''}`); }
    } else {
      console.log(`── ${ff}  n=${F.n} base=${(base * 100).toFixed(1)}% Brier=${brier.toFixed(3)} logloss=${ll.toFixed(3)} ECE=${(ece * 100).toFixed(1)}%`);
      for (let i = 0; i < 10; i++) { const b = F.buckets[i]; if (!b.n) continue; const pred = b.sp / b.n * 100, act = b.sy / b.n * 100, gap = pred - act; console.log(`     [${String(i * 10).padStart(2)}-${i * 10 + 10}%] pred ${pred.toFixed(0).padStart(3)}%  real ${act.toFixed(0).padStart(3)}%  n=${String(b.n).padStart(5)}  gap ${gap >= 0 ? '+' : ''}${gap.toFixed(0)}${Math.abs(gap) >= 10 ? '  <- desfase' : ''}`); }
    }
  }
  console.log(`\n=== GLOBAL RAW  Brier=${(gBrier / gN).toFixed(3)}  ECE=${(gECE / gN * 100).toFixed(1)}% ===`);
  if (USE_SHRINK) console.log(`=== GLOBAL SHRUNK  Brier=${(gBrierS / gN).toFixed(3)}  ECE=${(gECES / gN * 100).toFixed(1)}%  (menor = mejor calibrado) ===`);
  console.log('gap + = SOBRECONFIADO. Objetivo del shrink: acercar pred↔real sin isotónica, ponderando por muestra.');
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
