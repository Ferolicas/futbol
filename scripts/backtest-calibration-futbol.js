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
const { computeContext, scoreContext, isKeyInjury, marketFamily } = require('../lib/context-engine');

const args = process.argv.slice(2);
const USE_ML = args.includes('--ml');
const ONLY_FAM = (args.find(a => a.startsWith('--family=')) || '').split('=')[1] || null;

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
  const c01 = (p) => Math.max(1e-6, Math.min(1 - 1e-6, p));

  let nFix = 0;
  for (const r of fxRows) {
    const f = r.payload;
    if (!FINISHED.has(f.fixture?.status?.short)) continue;
    const homeId = f.teams?.home?.id, awayId = f.teams?.away?.id; if (!homeId || !awayId) continue;
    const fid = Number(f.fixture.id);
    const actuals = buildActuals(f, stById.get(fid) || null, evById.get(fid) || null, hsById.get(fid) || null);
    if (!actuals) continue;
    const beforeMs = new Date(f.fixture.date).getTime();
    const pit = (recs) => recs.filter(x => x && x.date && new Date(x.date).getTime() < beforeMs);
    const homeRecs = pit(teamRecords(homeId)), awayRecs = pit(teamRecords(awayId));
    const meetings = meetingsPIT(homeId, awayId, beforeMs);
    if (!homeRecs.length && !awayRecs.length && !meetings.length) continue;
    const ctxOut = computeContext({ homeId, awayId, meetings, homeRecords: homeRecs, awayRecords: awayRecs });
    if (!Object.keys(ctxOut).length) continue;
    const todayCtx = { knockout: (actuals.phase === 'knockout' || actuals.phase === 'final'), keyInjury: isKeyInjury(injById.get(fid), modalXIByTeam) };
    const scored = scoreContext(ctxOut, { meetings, ctx: {}, modalXIByTeam, todayCtx, homeId, awayId, homeRecords: homeRecs, awayRecords: awayRecs, homeTeamRecords: teamRecords(homeId), awayTeamRecords: teamRecords(awayId), mlEnabled: USE_ML });
    nFix++;
    for (const [key, sc] of Object.entries(scored)) {
      const def = MARKET_DEFS[key]; if (!def) continue;
      if (!def.gate(actuals)) continue;
      const p = sc.prob_final; if (p == null || !isFinite(p)) continue;
      const ff = marketFamily(key); if (ONLY_FAM && ff !== ONLY_FAM) continue;
      const y = def.outcome(actuals) ? 1 : 0;
      const F = ensure(ff);
      const bi = Math.min(9, Math.max(0, Math.floor(p * 10)));
      F.buckets[bi].sp += p; F.buckets[bi].sy += y; F.buckets[bi].n++;
      F.brier += (p - y) * (p - y); F.ll += -(y * Math.log(c01(p)) + (1 - y) * Math.log(1 - c01(p))); F.n++; F.sumy += y;
    }
  }

  console.log(`\n[backtest] fixtures evaluados: ${nFix} · ML: ${USE_ML ? 'ON' : 'off (motor empírico base)'}\n`);
  const fams = Object.keys(fam).sort();
  let gBrier = 0, gN = 0, gECE = 0;
  for (const ff of fams) {
    const F = fam[ff]; if (!F.n) continue;
    const brier = F.brier / F.n, ll = F.ll / F.n, base = F.sumy / F.n;
    let ece = 0; for (const b of F.buckets) { if (b.n) ece += (b.n / F.n) * Math.abs(b.sp / b.n - b.sy / b.n); }
    gBrier += F.brier; gN += F.n; gECE += ece * F.n;
    console.log(`── ${ff}  n=${F.n} base=${(base * 100).toFixed(1)}% Brier=${brier.toFixed(3)} logloss=${ll.toFixed(3)} ECE=${(ece * 100).toFixed(1)}%`);
    for (let i = 0; i < 10; i++) { const b = F.buckets[i]; if (!b.n) continue; const pred = b.sp / b.n * 100, act = b.sy / b.n * 100, gap = pred - act; console.log(`     [${String(i * 10).padStart(2)}-${i * 10 + 10}%] pred ${pred.toFixed(0).padStart(3)}%  real ${act.toFixed(0).padStart(3)}%  n=${String(b.n).padStart(5)}  gap ${gap >= 0 ? '+' : ''}${gap.toFixed(0)}${Math.abs(gap) >= 10 ? '  <- desfase' : ''}`); }
  }
  console.log(`\n=== GLOBAL  Brier=${(gBrier / gN).toFixed(3)}  ECE=${(gECE / gN * 100).toFixed(1)}%  muestras=${gN} ===`);
  console.log('gap + = SOBRECONFIADO (dice más de lo que ocurre). El objetivo de la calibración: acercar pred↔real (gap→0) sin isotónica.');
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
