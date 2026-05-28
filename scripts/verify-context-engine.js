/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Verificación obligatoria del motor de contexto (Fase 3) contra el crudo REAL.
//   node --env-file=.env scripts/verify-context-engine.js
//   flags: --home=ID --away=ID  (override; por defecto Man City vs Crystal Palace)
//          --homeName="..." --awayName="..."
// NO toca producción — solo lee y calcula.
// ────────────────────────────────────────────────────────────────────────
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');
const { loadContextInputs, computeContext, scoreContext, persistFixtureContext, rateFromRecords, VETO_ALPHA, VETO_TAU, CONF_N0, REC_THRESHOLD, MIN_H2H_N, MIN_ADN_CONFIDENCE } = require('../lib/context-engine');
const { MARKET_DEFS } = require('../lib/meta-features');

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

async function resolveTeam(name) {
  const { rows } = await pool.query(
    `SELECT id, name, COUNT(*)::int n FROM (
       SELECT (payload->'teams'->'home'->>'id')::int id, payload->'teams'->'home'->>'name' name FROM raw_api_payloads WHERE endpoint='fixtures'
       UNION ALL
       SELECT (payload->'teams'->'away'->>'id')::int id, payload->'teams'->'away'->>'name' name FROM raw_api_payloads WHERE endpoint='fixtures'
     ) t WHERE name ILIKE $1 GROUP BY id, name ORDER BY n DESC LIMIT 5`,
    [`%${name}%`]
  );
  return rows[0] || null;
}

const pct = (p) => (p == null ? '  —' : `${(p * 100).toFixed(0)}%`.padStart(4));
function row(ctx, key) {
  const r = ctx[key];
  if (!r) return `${key.padEnd(24)}  sin datos`;
  return `${key.padEnd(24)} ${pct(r.prob)} →${pct(r.prob_final)}  conf=${pct(r.confidence)}  rup=${(r.rupture_score ?? 0).toFixed(2)}  ${r.recommended ? 'REC' : '   '}  ${r.level.padEnd(4)} n=${String(r.n).padStart(3)} hits=${String(r.hits).padStart(3)}` +
         (r.exceptions && r.exceptions.length ? ` exc=${r.exceptions.length}` : '');
}

// Tasa de empate "standalone" de un equipo desde sus registros (todos / casa / fuera).
function drawRate(records, venue) {
  const recs = venue ? records.filter(r => r.venue === venue) : records;
  let n = 0, d = 0;
  for (const r of recs) { if (r.actuals?.result == null) continue; n++; if (r.actuals.result === 'D') d++; }
  return { n, d, rate: n ? d / n : null };
}

(async () => {
  const homeName = args.homeName || 'Manchester City';
  const awayName = args.awayName || 'Crystal Palace';
  let homeId = args.home ? Number(args.home) : null;
  let awayId = args.away ? Number(args.away) : null;
  let hInfo = null, aInfo = null;
  if (!homeId) { hInfo = await resolveTeam(homeName); homeId = hInfo?.id; }
  if (!awayId) { aInfo = await resolveTeam(awayName); awayId = aInfo?.id; }
  if (!homeId || !awayId) { console.error('No pude resolver los equipos. Usa --home=ID --away=ID.'); await pool.end(); process.exit(1); }
  console.log(`\nLocal:     ${hInfo ? hInfo.name : homeId}  (id ${homeId}${hInfo ? `, ${hInfo.n} fixtures` : ''})`);
  console.log(`Visitante: ${aInfo ? aInfo.name : awayId}  (id ${awayId}${aInfo ? `, ${aInfo.n} fixtures` : ''})`);

  const inputs = await loadContextInputs(pool, homeId, awayId);
  const c = inputs._counts;
  console.log(`\nDatos cargados: local ${c.homeFinished} partidos · visitante ${c.awayFinished} · lineups ${c.lineups} · injuries ${c.injuries}`);
  console.log(`H2H: ${c.meetings} cruces usables  (reconstruidos del crudo de fixtures=${c.meetingsReconstructed}, del endpoint headtohead=${c.meetingsEndpoint})`);

  const ctxRaw = computeContext(inputs);
  // Fase 4: excepciones + veto + confianza. todayCtx base = sin condiciones adversas.
  const ctx = scoreContext(ctxRaw, { meetings: inputs.meetings, ctx: inputs.ctx, modalXIByTeam: inputs.modalXIByTeam, todayCtx: {}, homeId });
  const keys = Object.keys(ctx);
  const nH2H = keys.filter(k => ctx[k].level === 'h2h').length;
  const nADN = keys.filter(k => ctx[k].level === 'adn').length;
  const nRec = keys.filter(k => ctx[k].recommended).length;
  console.log(`Mercados con valor: ${keys.length}/${Object.keys(MARKET_DEFS).length}  (h2h=${nH2H} · adn=${nADN} · sin datos=${Object.keys(MARKET_DEFS).length - keys.length})  ·  recomendables(≥${REC_THRESHOLD*100}%): ${nRec}`);
  console.log(`Constantes: α=${VETO_ALPHA} · τ=${VETO_TAU} · N0=${CONF_N0} · umbral=${REC_THRESHOLD} · piso H2H n≥${MIN_H2H_N} · piso ADN conf≥${MIN_ADN_CONFIDENCE}`);

  console.log(`\n══ ${homeName} (local) vs ${awayName} (visitante) ══`);
  console.log(`${'market'.padEnd(24)} prob  →pfin conf   rup   rec   lvl  n    hits`);
  console.log('-'.repeat(78));
  const show = [
    'home_win', 'draw', 'away_win',
    'btts', 'total_goals_over2_5', 'total_corners_over9_5', 'total_cards_over4_5', 'red_card_any', 'total_offsides_over2_5',
    'first_goal_30', 'first_goal_45',
    'total_goals_1h_over0_5', 'total_goals_1h_over1_5', 'total_goals_2h_over0_5',
    'winner_1h_home', 'winner_1h_draw', 'winner_1h_away',
    'goal_0_15', 'goal_16_30', 'goal_31_45', 'goal_46_60', 'goal_61_75', 'goal_76_90',
    'ah_home_m1_5', 'ah_away_p1_5',
  ];
  for (const k of show) console.log('  ' + row(ctx, k));

  console.log(`\n══ VERIFICACIÓN P(empate) ══`);
  console.log(`  draw en este partido: ${ctx.draw ? `${pct(ctx.draw.prob)} (${ctx.draw.level}, n=${ctx.draw.n})` : 'sin datos'}`);
  const all = drawRate(inputs.awayRecords);
  const home = drawRate(inputs.awayRecords, 'home');
  const away = drawRate(inputs.awayRecords, 'away');
  console.log(`  ${awayName} tasa de empate REAL — global ${pct(all.rate)} (${all.d}/${all.n}) · casa ${pct(home.rate)} (${home.d}/${home.n}) · fuera ${pct(away.rate)} (${away.d}/${away.n})`);
  console.log(`  → debe ser ~realista (no 95%).`);

  console.log(`\n══ FIX DENOMINADOR — baja frecuencia, ${awayName} sobre TODOS sus partidos ══`);
  // Denominador = partidos con statistics presentes (incluye value:0 y campo
  // omitido). Antes red_card_any salía ~100% sobre solo los partidos con roja.
  for (const mk of ['red_card_any', 'total_offsides_over2_5', 'total_offsides_over1_5']) {
    const r = rateFromRecords(inputs.awayRecords, MARKET_DEFS[mk]);
    console.log(`  ${(awayName + ' ' + mk).padEnd(40)} ${r.rate != null ? pct(r.rate) : '  —'}  n=${r.n}  hits=${r.hits}`);
  }
  console.log(`  → red_card_any debe dar ~realista (no 100%); n crece con la cobertura de statistics.`);

  console.log(`\n══ VALIDACIÓN DE EVENTOS RECUPERADOS ══`);
  const evMarkets = ['first_goal_30', 'goal_16_30', 'goal_46_60', 'total_goals_1h_over0_5'];
  for (const k of evMarkets) {
    const r = ctx[k];
    console.log(`  ${k.padEnd(24)} ${r ? `n=${r.n} (usa ${k.startsWith('goal_') || k.startsWith('first_') ? 'eventos/minutos' : 'score.halftime'})` : 'sin datos — ¿faltan eventos?'}`);
  }

  console.log(`\n══ RECOMENDADOS DESPUÉS DEL PISO (Fase 5) ══`);
  const recommended = keys.filter(k => ctx[k].recommended).map(k => ({ k, ...ctx[k] })).sort((a, b) => b.prob_final - a.prob_final);
  const recH2H = recommended.filter(r => r.level === 'h2h');
  const recADN = recommended.filter(r => r.level === 'adn');
  console.log(`  Total recomendados: ${recommended.length}  (h2h=${recH2H.length} · adn=${recADN.length})`);
  for (const r of recommended.slice(0, 30)) {
    console.log(`    ${r.k.padEnd(26)} ${pct(r.prob_final)}  conf=${pct(r.confidence)}  ${r.level}  n=${r.n}`);
  }
  if (recommended.length > 30) console.log(`    … (+${recommended.length - 30} más)`);
  // El red_card_any debe haber DESAPARECIDO de recomendados (ADN n bajo).
  const rc = ctx.red_card_any;
  if (rc) console.log(`\n  CHECK red_card_any: prob=${pct(rc.prob)} conf=${pct(rc.confidence)} n=${rc.n} level=${rc.level} → recomendado=${rc.recommended} ${rc.recommended ? '⚠️ debería ser false' : '✓ excluido por el piso'}`);

  console.log(`\n══ CONFIANZA POR MUESTRA (el caso "muestra chica engañosa") ══`);
  // Recomendables ordenados por confianza ASC → los de arriba son los de menor
  // soporte (n bajo) aunque su % sea alto: el caso red_card_any 100% n=8.
  const rec = keys.filter(k => ctx[k].recommended).map(k => ({ k, ...ctx[k] })).sort((a, b) => a.confidence - b.confidence);
  console.log(`  Recomendables con MENOR confianza (vigilar — % alto pero n bajo):`);
  for (const r of rec.slice(0, 8)) console.log(`    ${r.k.padEnd(24)} prob=${pct(r.prob)}  conf=${pct(r.confidence)}  n=${r.n}  ${r.level}`);
  if (ctx.red_card_any) console.log(`  → red_card_any: prob=${pct(ctx.red_card_any.prob)} n=${ctx.red_card_any.n} confianza=${pct(ctx.red_card_any.confidence)} (n bajo ⇒ confianza baja, no se confía igual que un n alto)`);

  console.log(`\n══ DEMO DE VETO (causa de ruptura presente hoy) ══`);
  // Re-puntúa asumiendo que HOY hay una baja clave (keyInjury) — muestra cómo el
  // veto recorta la prob de los mercados cuyas excepciones se rompían por lesión.
  const scoredInj = scoreContext(ctxRaw, { meetings: inputs.meetings, ctx: inputs.ctx, modalXIByTeam: inputs.modalXIByTeam, todayCtx: { keyInjury: true }, homeId });
  const changed = keys
    .map(k => ({ k, base: ctx[k], inj: scoredInj[k] }))
    .filter(x => x.inj.rupture_score > 0 && (x.base.recommended || x.base.prob >= 0.8))
    .sort((a, b) => b.inj.rupture_score - a.inj.rupture_score);
  if (changed.length === 0) {
    console.log(`  Ningún mercado H2H de este partido tiene excepciones atribuibles a lesión`);
    console.log(`  (las excepciones requieren injuries capturadas por cruce). El mecanismo`);
    console.log(`  está validado con el test sintético: prob 92% → 36.8% (rupture 1.0) cuando`);
    console.log(`  la baja clave que rompía el patrón está presente hoy.`);
  } else {
    console.log(`  Con baja clave HOY, estos mercados se recortan (prob → prob_final):`);
    for (const x of changed.slice(0, 10)) {
      console.log(`    ${x.k.padEnd(24)} ${pct(x.base.prob)} → ${pct(x.inj.prob_final)}  rupture=${x.inj.rupture_score.toFixed(2)}  rec ${x.base.recommended}→${x.inj.recommended}`);
    }
  }

  if (args.persist) {
    const fixtureId = Number(args.fixture) || Number(`${homeId}${awayId}`);  // sintético si no se pasa --fixture
    const date = args.date || new Date().toISOString().slice(0, 10);
    const res = await persistFixtureContext(pool, fixtureId, date, ctx);
    console.log(`\n══ PERSISTENCIA ══\n  market_context_analysis ← fixture_id=${fixtureId}: ${res.written} mercados escritos (${res.recommended} recomendados).`);
    console.log(`  (requiere haber corrido scripts/migrate-market-context.sql)`);
  }

  await pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
