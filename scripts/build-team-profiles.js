/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Construye team_market_profiles: el ADN de cada equipo por métrica, con
// shrinkage bayesiano hacia el prior global (equipos con pocos partidos se
// acercan a la media; con muchos, a su empírico real).
//
//   node --env-file=.env scripts/build-team-profiles.js
// ────────────────────────────────────────────────────────────────────────
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

const PRIOR_N = 8;       // fuerza del prior para tasas
const PRIOR_N_AVG = 6;   // para promedios (corners/cards)

// Métricas: rate = tasa 0-1 (hits/total); avg = promedio.
const RATE_METRICS = ['homeWinRate', 'homeLossRate', 'awayWinRate', 'awayLossRate', 'drawRate', 'bttsRate', 'over25Rate', 'scoredRate', 'cleanSheetRate'];
const AVG_METRICS = ['cornersForAvg', 'cornersAgainstAvg', 'cardsForAvg'];

function blankAcc() {
  return {
    homeN: 0, homeWins: 0, homeLosses: 0,
    awayN: 0, awayWins: 0, awayLosses: 0,
    matchN: 0, draws: 0,
    bttsN: 0, btts: 0,
    ouN: 0, over25: 0,
    goalsN: 0, scored: 0, clean: 0,
    cornN: 0, cornFor: 0, cornAgainst: 0,
    cardN: 0, cardFor: 0,
  };
}

function accumulate(acc, side, a) {
  const isHome = side === 'home';
  acc.matchN++;
  if (a.result === 'D') acc.draws++;
  if (isHome) { acc.homeN++; if (a.result === 'H') acc.homeWins++; else if (a.result === 'A') acc.homeLosses++; }
  else { acc.awayN++; if (a.result === 'A') acc.awayWins++; else if (a.result === 'H') acc.awayLosses++; }

  if (a.goals?.btts != null) { acc.bttsN++; if (a.goals.btts) acc.btts++; }
  if (a.goals?.total != null) { acc.ouN++; if (a.goals.total > 2.5) acc.over25++; }

  const gf = isHome ? a.goals?.home : a.goals?.away;
  const ga = isHome ? a.goals?.away : a.goals?.home;
  if (gf != null && ga != null) { acc.goalsN++; if (gf > 0) acc.scored++; if (ga === 0) acc.clean++; }

  const cFor = isHome ? a.corners?.home : a.corners?.away;
  const cAg = isHome ? a.corners?.away : a.corners?.home;
  if (cFor != null && cAg != null) { acc.cornN++; acc.cornFor += cFor; acc.cornAgainst += cAg; }

  const cards = isHome ? a.cards?.home : a.cards?.away;
  if (cards != null) { acc.cardN++; acc.cardFor += cards; }
}

// Devuelve {value, n} por métrica desde el acumulador.
function metricValue(acc, metric) {
  switch (metric) {
    case 'homeWinRate':  return { v: acc.homeN ? acc.homeWins / acc.homeN : null, n: acc.homeN };
    case 'homeLossRate': return { v: acc.homeN ? acc.homeLosses / acc.homeN : null, n: acc.homeN };
    case 'awayWinRate':  return { v: acc.awayN ? acc.awayWins / acc.awayN : null, n: acc.awayN };
    case 'awayLossRate': return { v: acc.awayN ? acc.awayLosses / acc.awayN : null, n: acc.awayN };
    case 'drawRate':     return { v: acc.matchN ? acc.draws / acc.matchN : null, n: acc.matchN };
    case 'bttsRate':     return { v: acc.bttsN ? acc.btts / acc.bttsN : null, n: acc.bttsN };
    case 'over25Rate':   return { v: acc.ouN ? acc.over25 / acc.ouN : null, n: acc.ouN };
    case 'scoredRate':   return { v: acc.goalsN ? acc.scored / acc.goalsN : null, n: acc.goalsN };
    case 'cleanSheetRate': return { v: acc.goalsN ? acc.clean / acc.goalsN : null, n: acc.goalsN };
    case 'cornersForAvg':     return { v: acc.cornN ? acc.cornFor / acc.cornN : null, n: acc.cornN };
    case 'cornersAgainstAvg': return { v: acc.cornN ? acc.cornAgainst / acc.cornN : null, n: acc.cornN };
    case 'cardsForAvg':       return { v: acc.cardN ? acc.cardFor / acc.cardN : null, n: acc.cardN };
    default: return { v: null, n: 0 };
  }
}

(async () => {
  const { rows } = await pgPool.query(
    `SELECT home_team, away_team, actuals_full
     FROM match_predictions
     WHERE finalized_at IS NOT NULL AND actuals_full IS NOT NULL`
  );
  console.log(`\nPartidos finalizados con actuals: ${rows.length}`);

  const teams = {}; // teamId → acc
  const ensure = (id) => (teams[id] = teams[id] || blankAcc());

  for (const r of rows) {
    const a = r.actuals_full;
    const h = r.home_team?.id, aw = r.away_team?.id;
    if (!a || a.result == null) continue;
    if (h) accumulate(ensure(h), 'home', a);
    if (aw) accumulate(ensure(aw), 'away', a);
  }
  const teamIds = Object.keys(teams);
  console.log(`Equipos con datos: ${teamIds.length}`);

  // ── Priors globales (media ponderada por muestra de todos los equipos) ──
  const ALL_METRICS = [...RATE_METRICS, ...AVG_METRICS];
  const prior = {};
  for (const metric of ALL_METRICS) {
    let sumWV = 0, sumW = 0;
    for (const id of teamIds) {
      const { v, n } = metricValue(teams[id], metric);
      if (v != null && n > 0) { sumWV += v * n; sumW += n; }
    }
    prior[metric] = sumW > 0 ? sumWV / sumW : null;
  }
  console.log('Priors globales:', Object.fromEntries(ALL_METRICS.map(m => [m, prior[m] != null ? Math.round(prior[m] * 1000) / 1000 : null])));

  // ── Escribir perfiles con shrinkage ──
  let written = 0;
  for (const id of teamIds) {
    for (const metric of ALL_METRICS) {
      const { v, n } = metricValue(teams[id], metric);
      if (v == null || n === 0) continue;
      const p = prior[metric];
      const k = RATE_METRICS.includes(metric) ? PRIOR_N : PRIOR_N_AVG;
      const shrunk = p != null ? (n * v + k * p) / (n + k) : v;
      const consistency = n / (n + k);
      await pgPool.query(
        `INSERT INTO team_market_profiles (sport, team_id, metric, segment, sample_n, emp_value, shrunk_value, consistency, updated_at)
         VALUES ('football', $1, $2, 'all', $3, $4, $5, $6, NOW())
         ON CONFLICT (sport, team_id, metric, segment)
         DO UPDATE SET sample_n=EXCLUDED.sample_n, emp_value=EXCLUDED.emp_value, shrunk_value=EXCLUDED.shrunk_value, consistency=EXCLUDED.consistency, updated_at=NOW()`,
        [Number(id), metric, n, round4(v), round4(shrunk), round4(consistency)]
      );
      written++;
    }
  }

  console.log(`\n✓ Perfiles escritos: ${written} (${teamIds.length} equipos × ${ALL_METRICS.length} métricas)`);
  await pgPool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

function round4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
