/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Diagnóstico FOCALIZADO (read-only) de key_injury.
// Responde la pregunta exacta: ¿la feature key_injury que entró al training
// usa la lógica NUEVA (lesionado del XI habitual) o degeneró a la VIEJA
// ("hay alguna lesión")? Y si degeneró, ¿por qué (modalXIByTeam vacío)?
//
// Construye modalXIByTeam IGUAL que el trainer (mismas fuentes/funciones) y
// para 10 fixtures imprime lado a lado:  vieja(binaria)  vs  nueva(isKeyInjury).
// Además: prevalencia NUEVA vs VIEJA sobre TODAS las muestras finalizadas.
//
//   node --env-file=.env scripts/diagnose-keyinjury.js
// ────────────────────────────────────────────────────────────────────────
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');
const { FINISHED } = require('../lib/adn');
const { modalXIFromLineups } = require('../lib/h2h');
const { isKeyInjury } = require('../lib/context-engine');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 3,
});

const oldBinary = (injPayload) => {
  const inj = injPayload?.response || injPayload || [];
  return Array.isArray(inj) && inj.length > 0;
};

(async () => {
  console.log('\n══ DIAGNÓSTICO key_injury (nueva vs vieja) ══');

  const [{ rows: fxRows }, { rows: luRows }, { rows: injRows }] = await Promise.all([
    pool.query(`SELECT payload FROM raw_api_payloads WHERE endpoint='fixtures'`),
    pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures/lineups'`),
    pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='injuries' AND sub_key LIKE 'fx:%'`),
  ]);
  const injById = new Map(injRows.map(r => [Number(r.ref_id), r.payload]));

  // ── modalXIByTeam IGUAL que el trainer ──
  console.log(`\n── 0) FUENTES ──`);
  console.log(`  fixtures: ${fxRows.length} · fixtures/lineups: ${luRows.length} · injuries(fx:): ${injRows.length}`);
  if (!luRows.length) {
    console.log(`  ✗✗ NO HAY filas fixtures/lineups en raw_api_payloads → modalXIByTeam quedará VACÍO`);
    console.log(`     → isKeyInjury devolverá SIEMPRE false → key_injury constante 0 → ML no aprende. CAUSA RAÍZ.`);
  }
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
  console.log(`  modalXIByTeam.size (equipos con XI habitual): ${modalXIByTeam.size}`);
  const sampleTeams = [...modalXIByTeam.entries()].slice(0, 3);
  for (const [tid, set] of sampleTeams) console.log(`    team ${tid}: ${set.size} jugadores en XI → [${[...set].slice(0, 5).join(', ')}…]`);

  // ── 1) 10 fixtures lado a lado ──
  console.log(`\n── 1) 10 FIXTURES: vieja(binaria) vs nueva(isKeyInjury) ──`);
  console.log(`  ${'fixture'.padEnd(10)} ${'home'.padEnd(7)} ${'away'.padEnd(7)} ${'#inj'.padStart(5)}  vieja  nueva  ${'(titulares lesionados)'}`);
  let shown = 0, finished = 0, oldPos = 0, newPos = 0, diverge = 0;
  for (const r of fxRows) {
    const f = r.payload;
    if (!FINISHED.has(f.fixture?.status?.short)) continue;
    finished++;
    const fid = Number(f.fixture?.id);
    const homeId = f.teams?.home?.id, awayId = f.teams?.away?.id;
    const injPayload = injById.get(fid);
    const old = oldBinary(injPayload);
    const neu = isKeyInjury(injPayload, modalXIByTeam);
    if (old) oldPos++;
    if (neu) newPos++;
    if (old !== neu) diverge++;
    if (shown < 10 && (old || neu)) {
      const inj = injPayload?.response || injPayload || [];
      const n = Array.isArray(inj) ? inj.length : 0;
      const hit = (Array.isArray(inj) ? inj : []).filter(i => {
        const set = modalXIByTeam.get(i?.team?.id); return set && i?.player?.id != null && set.has(i.player.id);
      }).map(i => i.player?.name || i.player?.id);
      console.log(`  ${String(fid).padEnd(10)} ${String(homeId).padEnd(7)} ${String(awayId).padEnd(7)} ${String(n).padStart(5)}  ${old ? ' sí ' : ' no '}   ${neu ? ' sí ' : ' no '}   ${hit.length ? hit.slice(0, 4).join(', ') : '—'}`);
      shown++;
    }
  }

  // ── 2) Prevalencia global nueva vs vieja ──
  const pc = (n) => finished ? `${(100 * n / finished).toFixed(1)}%` : '0%';
  console.log(`\n── 2) PREVALENCIA sobre ${finished} muestras finalizadas ──`);
  console.log(`  VIEJA (hay alguna lesión):      ${oldPos} (${pc(oldPos)})`);
  console.log(`  NUEVA (titular del XI fuera):    ${newPos} (${pc(newPos)})`);
  console.log(`  fixtures donde difieren:         ${diverge} (${pc(diverge)})`);
  console.log(`\n  VEREDICTO:`);
  if (modalXIByTeam.size === 0) {
    console.log(`  ✗ modalXIByTeam VACÍO → la nueva feature es constante 0. El ML entrenó con key_injury inútil.`);
    console.log(`    Arreglo: capturar/seedear fixtures/lineups en raw_api_payloads, luego re-entrenar.`);
  } else if (newPos === oldPos && diverge === 0) {
    console.log(`  ✗ nueva == vieja en TODO → bug: el modal XI no está filtrando (revisar startXI/ids).`);
  } else if (newPos < oldPos) {
    console.log(`  ✓ La nueva feature ES más estricta (${pc(newPos)} vs ${pc(oldPos)}). Lógica OK.`);
    console.log(`    Si el coef no subió, el cuello es otro (pocas muestras positivas, o el mercado).`);
  } else {
    console.log(`  ? nueva (${pc(newPos)}) ≥ vieja (${pc(oldPos)}) — inesperado, revisar.`);
  }

  await pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
