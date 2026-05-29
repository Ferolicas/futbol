// ===================== DESCRIPTIVE STATS (no model) =====================
// Helpers DESCRIPTIVOS puros — resumen de datos reales, SIN Dixon-Coles, SIN
// lambdas, SIN isotónica. Extraídos de lib/calculations.js (eliminado en la purga
// DC) porque el motor de contexto (lib/context-probabilities.js) y el frontend los
// usan solo para los widgets de forma/H2H/goal-timing.

function getGoals(f) {
  const home = f?.goals?.home ?? f?.score?.fulltime?.home ?? 0;
  const away = f?.goals?.away ?? f?.score?.fulltime?.away ?? 0;
  return { home, away };
}
function wasHome(f, teamId) { return f?.teams?.home?.id === teamId; }
function clamp(val, min = 0, max = 100) { return Math.max(min, Math.min(max, val)); }

export function calculateGoalTimingProbabilities(goalTimingData) {
  const periods = ['0-15', '15-30', '30-45', '45-60', '60-75', '75-90'];

  function computeTeamTiming(teamData) {
    if (!teamData?.totalMatches || teamData.totalMatches <= 0) {
      return periods.map(period => ({ period, probability: 0, highlight: false }));
    }
    const n = teamData.totalMatches;
    return periods.map(period => {
      const periodData = teamData.periods?.[period];
      const count = periodData
        ? (periodData.scored || 0) + (periodData.conceded || 0)
        : (teamData[period] || 0);
      const prob = clamp(Math.round((count / n) * 100), 5, 95);
      return { period, probability: prob, highlight: prob > 70 };
    });
  }

  const home = computeTeamTiming(goalTimingData?.home);
  const away = computeTeamTiming(goalTimingData?.away);

  // P(at least one team scores in period) = 1 − (1−pH)(1−pA)
  const combined = periods.map((period, i) => {
    const pH = home[i].probability / 100;
    const pA = away[i].probability / 100;
    const pC = clamp(Math.round((1 - (1 - pH) * (1 - pA)) * 100), 5, 95);
    return { period, probability: pC, highlight: pC > 70 };
  });

  return { home, away, combined };
}

export function calculateForm(lastFive, teamId) {
  if (!lastFive?.length) return { results: [], points: 0, maxPoints: 0 };
  const results = lastFive.map(f => {
    const { home, away } = getGoals(f);
    const isHome  = wasHome(f, teamId);
    const scored  = isHome ? home : away;
    const conceded = isHome ? away : home;
    const result  = scored > conceded ? 'W' : scored < conceded ? 'L' : 'D';
    return {
      result, goalsFor: scored, goalsAgainst: conceded,
      opponent:     isHome ? f.teams?.away?.name : f.teams?.home?.name,
      opponentLogo: isHome ? f.teams?.away?.logo : f.teams?.home?.logo,
      date: f.fixture?.date, wasHome: isHome,
    };
  });
  const points = results.reduce((s, r) => s + (r.result === 'W' ? 3 : r.result === 'D' ? 1 : 0), 0);
  return { results, points, maxPoints: lastFive.length * 3 };
}

export function calculateGoalAverages(lastFive, teamId) {
  if (!lastFive?.length) return { avgScored: 0, avgConceded: 0, avgTotal: 0, totalScored: 0, totalConceded: 0 };
  let totalScored = 0, totalConceded = 0;
  lastFive.forEach(f => {
    const { home, away } = getGoals(f);
    const isHome = wasHome(f, teamId);
    totalScored   += isHome ? home : away;
    totalConceded += isHome ? away : home;
  });
  const n = lastFive.length;
  return {
    avgScored:   +(totalScored   / n).toFixed(2),
    avgConceded: +(totalConceded / n).toFixed(2),
    avgTotal:    +((totalScored + totalConceded) / n).toFixed(2),
    totalScored, totalConceded,
  };
}

export function calculateH2HGoalAvg(h2h, homeId) {
  if (!h2h?.length) return { homeAvg: 0, awayAvg: 0, totalAvg: 0 };
  let homeGoals = 0, awayGoals = 0;
  h2h.forEach(f => {
    const { home, away } = getGoals(f);
    if (f.teams?.home?.id === homeId) { homeGoals += home; awayGoals += away; }
    else                               { homeGoals += away; awayGoals += home; }
  });
  const n = h2h.length;
  return {
    homeAvg:  +(homeGoals / n).toFixed(2),
    awayAvg:  +(awayGoals / n).toFixed(2),
    totalAvg: +((homeGoals + awayGoals) / n).toFixed(2),
  };
}

export function calculateH2HSummary(h2h, homeId, awayId) {
  if (!h2h?.length) return { homeWins: 0, draws: 0, awayWins: 0, total: 0 };
  let homeWins = 0, draws = 0, awayWins = 0;
  h2h.forEach(f => {
    const { home, away } = getGoals(f);
    const fHomeId = f.teams?.home?.id;
    const htGoals = fHomeId === homeId ? home : away;
    const atGoals = fHomeId === homeId ? away : home;
    if (htGoals > atGoals) homeWins++;
    else if (htGoals < atGoals) awayWins++;
    else draws++;
  });
  return { homeWins, draws, awayWins, total: h2h.length };
}
