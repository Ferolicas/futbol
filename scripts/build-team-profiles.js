/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Construye team_market_profiles: el ADN de cada equipo, con shrinkage
// bayesiano hacia el prior global.
//
// COBERTURA del ADN (responde a "¿toma todas las muestras y escenarios?"):
//   - Usa TODOS los partidos finalizados del equipo (no una ventana de 3-4).
//   - 18 métricas: resultado por localía, BTTS, over2.5, scored, clean-sheet,
//     y PROMEDIOS de goles/corners/tarjetas/remates/SoT/faltas a favor y en
//     contra. Los promedios son el estadístico suficiente: derivan CUALQUIER
//     línea over/under del meta-modelo (no hace falta una métrica por línea).
//   - 3 SEGMENTOS: 'all', 'home', 'away'. El meta-modelo usa el ADN del local
//     COMO LOCAL y del visitante COMO VISITANTE (el corners en casa ≠ fuera).
//   - Shrinkage por (métrica, segmento): equipos con pocos partidos → prior;
//     con muchos → su empírico real. consistency = soporte muestral.
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
const PRIOR_N_AVG = 6;   // para promedios
const SEGMENTS = ['all', 'home', 'away'];

const RATE_METRICS = ['homeWinRate', 'homeLossRate', 'awayWinRate', 'awayLossRate', 'drawRate', 'bttsRate', 'over25Rate', 'scoredRate', 'cleanSheetRate'];
const AVG_METRICS = ['goalsForAvg', 'goalsAgainstAvg', 'cornersForAvg', 'cornersAgainstAvg', 'cardsForAvg', 'shotsForAvg', 'shotsAgainstAvg', 'sotForAvg', 'foulsForAvg'];
const ALL_METRICS = [...RATE_METRICS, ...AVG_METRICS];

function blankAcc() {
  return {
    homeN: 0, homeWins: 0, homeLosses: 0, awayN: 0, awayWins: 0, awayLosses: 0,
    matchN: 0, draws: 0, bttsN: 0, btts: 0, ouN: 0, over25: 0,
    goalsN: 0, scored: 0, clean: 0, goalsForSum: 0, goalsAgainstSum: 0,
    cornN: 0, cornFor: 0, cornAgainst: 0, cardN: 0, cardFor: 0,
    shotN: 0, shotFor: 0, shotAgainst: 0, sotN: 0, sotFor: 0, foulN: 0, foulFor: 0,
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
  if (gf != null && ga != null) { acc.goalsN++; if (gf > 0) acc.scored++; if (ga === 0) acc.clean++; acc.goalsForSum += gf; acc.goalsAgainstSum += ga; }

  const cFor = isHome ? a.corners?.home : a.corners?.away;
  const cAg = isHome ? a.corners?.away : a.corners?.home;
  if (cFor != null && cAg != null) { acc.cornN++; acc.cornFor += cFor; acc.cornAgainst += cAg; }

  const cards = isHome ? a.cards?.home : a.cards?.away;
  if (cards != null) { acc.cardN++; acc.cardFor += cards; }

  const sFor = isHome ? a.shots?.home : a.shots?.away;
  const sAg = isHome ? a.shots?.away : a.shots?.home;
  if (sFor != null && sAg != null) { acc.shotN++; acc.shotFor += sFor; acc.shotAgainst += sAg; }

  const sotFor = isHome ? a.shots?.onTargetHome : a.shots?.onTargetAway;
  if (sotFor != null) { acc.sotN++; acc.sotFor += sotFor; }

  const fFor = isHome ? a.fouls?.home : a.fouls?.away;
  if (fFor != null) { acc.foulN++; acc.foulFor += fFor; }
}

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
    case 'goalsForAvg':     return { v: acc.goalsN ? acc.goalsForSum / acc.goalsN : null, n: acc.goalsN };
    case 'goalsAgainstAvg': return { v: acc.goalsN ? acc.goalsAgainstSum / acc.goalsN : null, n: acc.goalsN };
    case 'cornersForAvg':     return { v: acc.cornN ? acc.cornFor / acc.cornN : null, n: acc.cornN };
    case 'cornersAgainstAvg': return { v: acc.cornN ? acc.cornAgainst / acc.cornN : null, n: acc.cornN };
    case 'cardsForAvg':       return { v: acc.cardN ? acc.cardFor / acc.cardN : null, n: acc.cardN };
    case 'shotsForAvg':       return { v: acc.shotN ? acc.shotFor / acc.shotN : null, n: acc.shotN };
    case 'shotsAgainstAvg':   return { v: acc.shotN ? acc.shotAgainst / acc.shotN : null, n: acc.shotN };
    case 'sotForAvg':         return { v: acc.sotN ? acc.sotFor / acc.sotN : null, n: acc.sotN };
    case 'foulsForAvg':       return { v: acc.foulN ? acc.foulFor / acc.foulN : null, n: acc.foulN };
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

  // teams[id] = { all, home, away } accs
  const teams = {};
  const ensure = (id) => (teams[id] = teams[id] || { all: blankAcc(), home: blankAcc(), away: blankAcc() });

  for (const r of rows) {
    const a = r.actuals_full;
    if (!a || a.result == null) continue;
    const h = r.home_team?.id, aw = r.away_team?.id;
    if (h) { const t = ensure(h); accumulate(t.all, 'home', a); accumulate(t.home, 'home', a); }
    if (aw) { const t = ensure(aw); accumulate(t.all, 'away', a); accumulate(t.away, 'away', a); }
  }
  const teamIds = Object.keys(teams);
  console.log(`Equipos con datos: ${teamIds.length}`);

  // Priors globales por (métrica, segmento) — media ponderada por muestra.
  const prior = {};
  for (const seg of SEGMENTS) {
    prior[seg] = {};
    for (const metric of ALL_METRICS) {
      let sumWV = 0, sumW = 0;
      for (const id of teamIds) {
        const { v, n } = metricValue(teams[id][seg], metric);
        if (v != null && n > 0) { sumWV += v * n; sumW += n; }
      }
      prior[seg][metric] = sumW > 0 ? sumWV / sumW : null;
    }
  }

  let written = 0;
  for (const id of teamIds) {
    for (const seg of SEGMENTS) {
      for (const metric of ALL_METRICS) {
        const { v, n } = metricValue(teams[id][seg], metric);
        if (v == null || n === 0) continue;
        const p = prior[seg][metric];
        const k = RATE_METRICS.includes(metric) ? PRIOR_N : PRIOR_N_AVG;
        const shrunk = p != null ? (n * v + k * p) / (n + k) : v;
        const consistency = n / (n + k);
        await pgPool.query(
          `INSERT INTO team_market_profiles (sport, team_id, metric, segment, sample_n, emp_value, shrunk_value, consistency, updated_at)
           VALUES ('football', $1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (sport, team_id, metric, segment)
           DO UPDATE SET sample_n=EXCLUDED.sample_n, emp_value=EXCLUDED.emp_value, shrunk_value=EXCLUDED.shrunk_value, consistency=EXCLUDED.consistency, updated_at=NOW()`,
          [Number(id), metric, seg, n, round4(v), round4(shrunk), round4(consistency)]
        );
        written++;
      }
    }
  }

  console.log(`\n✓ Perfiles escritos: ${written} (${teamIds.length} equipos × ${ALL_METRICS.length} métricas × ${SEGMENTS.length} segmentos)`);
  await pgPool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

function round4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
