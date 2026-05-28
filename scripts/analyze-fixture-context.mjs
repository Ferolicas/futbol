// ────────────────────────────────────────────────────────────────────────
// Fase 6a — análisis de prueba de un fixture REAL por el motor de contexto.
// Imprime las estadísticas descriptivas (promedio GENERAL del equipo) y los
// mercados (prob_final del motor) para comparar contra Dixon-Coles. NO toca
// producción, NO activa el flag — solo lee y calcula.
//
//   node --env-file=.env scripts/analyze-fixture-context.mjs                 # Man City vs Crystal Palace
//   node --env-file=.env scripts/analyze-fixture-context.mjs --home=50 --away=52
//   node --env-file=.env scripts/analyze-fixture-context.mjs --homeName="Arsenal" --awayName="Chelsea"
// ────────────────────────────────────────────────────────────────────────
import pg from 'pg';
import { loadContextInputs, computeContext, scoreContext } from '../lib/context-engine.js';
import { buildProbabilitiesFromContext, buildContextCombinada, buildTodayCtx } from '../lib/context-probabilities.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }));
const pool = new pg.Pool({
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
  const { rows } = await pool.query(
    `SELECT payload->'teams'->'home'->>'name' n FROM raw_api_payloads WHERE endpoint='fixtures' AND payload->'teams'->'home'->>'id'=$1 LIMIT 1`, [String(id)]);
  if (rows[0]?.n) return rows[0].n;
  const { rows: r2 } = await pool.query(
    `SELECT payload->'teams'->'away'->>'name' n FROM raw_api_payloads WHERE endpoint='fixtures' AND payload->'teams'->'away'->>'id'=$1 LIMIT 1`, [String(id)]);
  return r2[0]?.n || `Equipo ${id}`;
}

const show = (v) => (v == null ? '—' : v);

(async () => {
  // Resolver ids + NOMBRES reales (arregla el título hardcodeado: si se pasan
  // ids, igual buscamos el nombre real del equipo en el crudo).
  let homeId, awayId, homeName, awayName;
  if (args.home) { homeId = Number(args.home); homeName = args.homeName || await teamNameById(homeId); }
  else { const t = await resolveTeam(args.homeName || 'Manchester City'); homeId = t?.id; homeName = t?.name; }
  if (args.away) { awayId = Number(args.away); awayName = args.awayName || await teamNameById(awayId); }
  else { const t = await resolveTeam(args.awayName || 'Crystal Palace'); awayId = t?.id; awayName = t?.name; }
  if (!homeId || !awayId) { console.error('No pude resolver equipos. Usa --home=ID --away=ID'); await pool.end(); process.exit(1); }

  const inputs = await loadContextInputs(pool, homeId, awayId);
  const todayCtx = buildTodayCtx({ leagueRound: 'Regular Season' });
  const scored = scoreContext(computeContext(inputs), {
    meetings: inputs.meetings, ctx: inputs.ctx, modalXIByTeam: inputs.modalXIByTeam, todayCtx, homeId,
    homeRecords: inputs.homeRecords, awayRecords: inputs.awayRecords,
  });
  const p = buildProbabilitiesFromContext(scored, inputs, { homeTeam: homeName, awayTeam: awayName, leagueRound: 'Regular Season' });

  console.log(`\n══ ${homeName} (local) vs ${awayName} (visitante) — MOTOR DE CONTEXTO ══`);
  console.log(`Partidos cargados: local ${inputs._counts.homeFinished} · visitante ${inputs._counts.awayFinished} · H2H ${inputs._counts.meetings} (reconstruidos ${inputs._counts.meetingsReconstructed})`);

  console.log(`\n── ESTADÍSTICAS DESCRIPTIVAS (promedio GENERAL del equipo, todos sus partidos) ──`);
  console.log(`  ${homeName}: marca ${show(p.homeGoals.avgScored)} / recibe ${show(p.homeGoals.avgConceded)} goles  (n=${p._contextMeta.homeMatches})`);
  console.log(`  ${awayName}: marca ${show(p.awayGoals.avgScored)} / recibe ${show(p.awayGoals.avgConceded)} goles  (n=${p._contextMeta.awayMatches})`);
  console.log(`  Córners: ${homeName} ${show(p.cornerCardData.homeCornersAvg)} a favor / ${show(p.cornerCardData.homeCornersAgainstAvg)} contra · ${awayName} ${show(p.cornerCardData.awayCornersAvg)} / ${show(p.cornerCardData.awayCornersAgainstAvg)}  · total ${show(p.cornerAvg)}`);
  console.log(`  Amarillas: ${homeName} ${show(p.cornerCardData.homeYellowsAvg)} · ${awayName} ${show(p.cornerCardData.awayYellowsAvg)}  · Rojas: ${show(p.cornerCardData.homeRedsAvg)} / ${show(p.cornerCardData.awayRedsAvg)}  · total tarjetas ${show(p.cardAvg)}`);
  console.log(`  Total goles esperado (descriptivo): ${show(p.overUnder.expectedTotal)}`);

  const M = (label, key) => { const r = scored[key]; console.log(`  ${label.padEnd(34)} ${r ? `${Math.round(r.prob_final * 100)}%  (${r.level}, n=${r.n})` : 'sin datos'}`); };
  console.log(`\n── MERCADOS (prob_final del motor; level=h2h específico / adn segmento) ──`);
  M('1X2 — local', 'home_win'); M('1X2 — empate', 'draw'); M('1X2 — visitante', 'away_win');
  M('BTTS sí', 'btts'); M('Over 1.5', 'total_goals_over1_5'); M('Over 2.5', 'total_goals_over2_5');
  M('Córners +9.5', 'total_corners_over9_5'); M('Tarjetas +3.5', 'total_cards_over3_5');
  M('Primer gol <30', 'first_goal_30'); M('Goles 1ªP +0.5', 'total_goals_1h_over0_5');
  M('Roja en el partido', 'red_card_any'); M('Offsides +2.5', 'total_offsides_over2_5');
  M('Local marca +0.5', 'home_goals_over0_5'); M('Más córners local', 'most_corners_home');

  console.log(`\n── SIN DIXON-COLES ──`);
  console.log(`  lambdaHome presente: ${p.lambdaHome !== undefined}  ·  lambdaAway presente: ${p.lambdaAway !== undefined}  ·  model: ${p.model}`);

  const allRec = Object.entries(scored).filter(([, r]) => r.recommended).sort((a, b) => b[1].prob_final - a[1].prob_final);
  console.log(`\n── RECOMENDABLES por el motor (≥90% prob_final + piso H2H n≥3 / ADN conf≥0.60): ${allRec.length} ──`);
  for (const [k, r] of allRec.slice(0, 25)) console.log(`  ${k.padEnd(28)} ${Math.round(r.prob_final * 100)}%  conf=${Math.round((r.confidence || 0) * 100)}%  ${r.level}  n=${r.n}`);
  console.log(`  (la combinada final además exige cuota real del bookmaker ≥1.20 — solo disponible en el análisis en vivo)`);

  await pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
