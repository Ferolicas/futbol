/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Paso 2 (Fase 6b) — verifica el ML detector de ruptura para un fixture REAL.
// Corre el motor DOS veces (sin ML / con ML) y compara por mercado:
//   rupture_h2h vs rupture_ml vs combinado · prob_final antes/después ·
//   qué mercados cambian de recomendado ↔ no recomendado.
// Solo lee y calcula — NO toca producción, NO activa el flag.
//
//   node --env-file=.env scripts/verify-ml-rupture.js                       # Man City vs Crystal Palace
//   node --env-file=.env scripts/verify-ml-rupture.js --home=ID --away=ID
//   node --env-file=.env scripts/verify-ml-rupture.js --homeName="..." --awayName="..."
//   flags extra (contexto de hoy): --knockout  --injury
// ────────────────────────────────────────────────────────────────────────
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');
const { loadContextInputs, computeContext, scoreContext, loadRuptureModels } = require('../lib/context-engine');

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 3,
});

async function resolveTeam(name) {
  const { rows } = await pool.query(
    `SELECT id, name, COUNT(*)::int n FROM (
       SELECT (payload->'teams'->'home'->>'id')::int id, payload->'teams'->'home'->>'name' name FROM raw_api_payloads WHERE endpoint='fixtures'
       UNION ALL
       SELECT (payload->'teams'->'away'->>'id')::int id, payload->'teams'->'away'->>'name' name FROM raw_api_payloads WHERE endpoint='fixtures'
     ) t WHERE name ILIKE $1 GROUP BY id, name ORDER BY n DESC LIMIT 1`, [`%${name}%`]);
  return rows[0] || null;
}
async function teamNameById(id) {
  const { rows } = await pool.query(`SELECT payload->'teams'->'home'->>'name' n FROM raw_api_payloads WHERE endpoint='fixtures' AND payload->'teams'->'home'->>'id'=$1 LIMIT 1`, [String(id)]);
  if (rows[0]?.n) return rows[0].n;
  const { rows: r2 } = await pool.query(`SELECT payload->'teams'->'away'->>'name' n FROM raw_api_payloads WHERE endpoint='fixtures' AND payload->'teams'->'away'->>'id'=$1 LIMIT 1`, [String(id)]);
  return r2[0]?.n || `Equipo ${id}`;
}
const pct = (p) => (p == null ? '  —' : `${(p * 100).toFixed(0)}%`.padStart(4));
const r2 = (v) => (v == null ? '0.00' : v.toFixed(2));

(async () => {
  let homeId, awayId, homeName, awayName;
  if (args.home) { homeId = Number(args.home); homeName = args.homeName || await teamNameById(homeId); }
  else { const t = await resolveTeam(args.homeName || 'Manchester City'); homeId = t?.id; homeName = t?.name; }
  if (args.away) { awayId = Number(args.away); awayName = args.awayName || await teamNameById(awayId); }
  else { const t = await resolveTeam(args.awayName || 'Crystal Palace'); awayId = t?.id; awayName = t?.name; }
  if (!homeId || !awayId) { console.error('No pude resolver equipos. Usa --home=ID --away=ID'); await pool.end(); process.exit(1); }

  const inputs = await loadContextInputs(pool, homeId, awayId);
  const mlModels = await loadRuptureModels(pool);
  const todayCtx = { knockout: !!args.knockout, keyInjury: !!args.injury };
  const ctxRaw = computeContext(inputs);
  const common = {
    meetings: inputs.meetings, ctx: inputs.ctx, modalXIByTeam: inputs.modalXIByTeam, todayCtx, homeId, awayId,
    homeRecords: inputs.homeRecords, awayRecords: inputs.awayRecords,
    homeTeamRecords: inputs.homeTeamRecords, awayTeamRecords: inputs.awayTeamRecords,
  };
  const base = scoreContext(ctxRaw, { ...common, mlEnabled: false });
  const withMl = scoreContext(ctxRaw, { ...common, mlModels, mlEnabled: true });

  const keys = Object.keys(ctxRaw);
  const withModel = keys.filter(k => mlModels.has(k));
  console.log(`\n══ ${homeName} vs ${awayName} — ML detector de ruptura (Paso 2) ══`);
  console.log(`H2H usables: ${inputs._counts.meetings} · modelos activos cargados: ${mlModels.size} · mercados del partido con modelo: ${withModel.length}/${keys.length}`);
  console.log(`todayCtx: knockout=${todayCtx.knockout} keyInjury=${todayCtx.keyInjury}  (usa --knockout/--injury para simular)`);

  // Mercados donde el ML modula (rupture_ml > 0), ordenados por impacto.
  const modulated = keys.filter(k => (withMl[k].rupture_ml || 0) > 0)
    .map(k => ({ k, b: base[k], m: withMl[k], drop: base[k].prob_final - withMl[k].prob_final }))
    .sort((a, b) => b.drop - a.drop);

  console.log(`\n── DONDE EL ML MODULA (rupture_ml>0): ${modulated.length} mercados ──`);
  console.log(`${'market'.padEnd(26)} prob   rup_h2h rup_ml  rup_comb  pfinal_base→ml   rec`);
  console.log('-'.repeat(82));
  for (const x of modulated.slice(0, 30)) {
    const flip = x.b.recommended !== x.m.recommended ? `  ${x.b.recommended ? 'REC→no' : 'no→REC'}` : '';
    console.log(`  ${x.k.padEnd(24)} ${pct(x.m.prob)}   ${r2(x.m.rupture_h2h)}    ${r2(x.m.rupture_ml)}    ${r2(x.m.rupture_score)}     ${pct(x.b.prob_final)} → ${pct(x.m.prob_final)}   ${x.m.recommended ? 'sí' : 'no'}${flip}`);
  }
  if (!modulated.length) console.log('  (ningún mercado con modelo activo + prob>0 en este partido)');

  // Flips de recomendación por el ML.
  const flips = keys.filter(k => base[k].recommended !== withMl[k].recommended)
    .map(k => ({ k, was: base[k].recommended, now: withMl[k].recommended, b: base[k], m: withMl[k] }));
  console.log(`\n── CAMBIOS DE RECOMENDACIÓN POR EL ML: ${flips.length} ──`);
  for (const f of flips) {
    console.log(`  ${f.k.padEnd(26)} ${f.was ? 'RECOMENDADO → NO' : 'no → RECOMENDADO'}  (prob_final ${pct(f.b.prob_final)}→${pct(f.m.prob_final)}, rupture_ml ${r2(f.m.rupture_ml)})`);
  }
  if (!flips.length) console.log('  (ninguno — el ML afina la confianza pero no cambia el set recomendado)');

  const recBase = keys.filter(k => base[k].recommended).length;
  const recMl = keys.filter(k => withMl[k].recommended).length;
  console.log(`\n── RESUMEN ──`);
  console.log(`  Recomendados SIN ML: ${recBase}  ·  CON ML: ${recMl}  ·  mercados modulados: ${modulated.length}  ·  flips: ${flips.length}`);
  console.log(`  (El ML solo modula la ruptura/confianza; las frecuencias L1/L2 del motor no cambian.)`);

  await pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
