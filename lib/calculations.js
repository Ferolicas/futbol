// ===================== PROBABILITY CALCULATIONS =====================
// All functions are pure — no side effects, no API calls

function safeDiv(a, b) { return b > 0 ? a / b : 0; }
function clamp(val, min = 0, max = 100) { return Math.max(min, Math.min(max, val)); }
function pct(val) { return Math.round(clamp(val * 100)); }

function getGoals(fixture) {
  const home = fixture?.goals?.home ?? fixture?.score?.fulltime?.home ?? 0;
  const away = fixture?.goals?.away ?? fixture?.score?.fulltime?.away ?? 0;
  return { home, away };
}

function wasHome(fixture, teamId) {
  return fixture?.teams?.home?.id === teamId;
}

// ===================== FORM =====================

export function calculateForm(lastFive, teamId) {
  if (!lastFive || lastFive.length === 0) return { results: [], points: 0, maxPoints: 0 };

  const results = lastFive.map(f => {
    const { home, away } = getGoals(f);
    const isHome = wasHome(f, teamId);
    const scored = isHome ? home : away;
    const conceded = isHome ? away : home;
    const result = scored > conceded ? 'W' : scored < conceded ? 'L' : 'D';
    return {
      result,
      goalsFor: scored,
      goalsAgainst: conceded,
      opponent: isHome ? f.teams?.away?.name : f.teams?.home?.name,
      opponentLogo: isHome ? f.teams?.away?.logo : f.teams?.home?.logo,
      date: f.fixture?.date,
      wasHome: isHome,
    };
  });

  const points = results.reduce((sum, r) => sum + (r.result === 'W' ? 3 : r.result === 'D' ? 1 : 0), 0);
  return { results, points, maxPoints: lastFive.length * 3 };
}

// ===================== GOAL AVERAGES =====================

export function calculateGoalAverages(lastFive, teamId) {
  if (!lastFive || lastFive.length === 0) {
    return { avgScored: 0, avgConceded: 0, avgTotal: 0, totalScored: 0, totalConceded: 0 };
  }

  let totalScored = 0, totalConceded = 0;
  lastFive.forEach(f => {
    const { home, away } = getGoals(f);
    const isHome = wasHome(f, teamId);
    totalScored += isHome ? home : away;
    totalConceded += isHome ? away : home;
  });

  const n = lastFive.length;
  return {
    avgScored: +(totalScored / n).toFixed(2),
    avgConceded: +(totalConceded / n).toFixed(2),
    avgTotal: +((totalScored + totalConceded) / n).toFixed(2),
    totalScored,
    totalConceded,
  };
}

export function calculateH2HGoalAvg(h2h, homeId) {
  if (!h2h || h2h.length === 0) return { homeAvg: 0, awayAvg: 0, totalAvg: 0 };

  let homeGoals = 0, awayGoals = 0;
  h2h.forEach(f => {
    const { home, away } = getGoals(f);
    if (f.teams?.home?.id === homeId) {
      homeGoals += home; awayGoals += away;
    } else {
      homeGoals += away; awayGoals += home;
    }
  });

  const n = h2h.length;
  return {
    homeAvg: +(homeGoals / n).toFixed(2),
    awayAvg: +(awayGoals / n).toFixed(2),
    totalAvg: +((homeGoals + awayGoals) / n).toFixed(2),
  };
}

// ===================== H2H SUMMARY =====================

export function calculateH2HSummary(h2h, homeId, awayId) {
  if (!h2h || h2h.length === 0) return { homeWins: 0, draws: 0, awayWins: 0, total: 0 };

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

// ===================== BTTS =====================

export function calculateBTTS(homeLastFive, awayLastFive, h2h, homeId, awayId) {
  if (!homeLastFive?.length && !awayLastFive?.length) return 50;

  const homeScored = homeLastFive?.filter(f => {
    const { home, away } = getGoals(f);
    return wasHome(f, homeId) ? home > 0 : away > 0;
  }).length || 0;
  const homeScoredPct = safeDiv(homeScored, homeLastFive?.length || 1);

  const awayScored = awayLastFive?.filter(f => {
    const { home, away } = getGoals(f);
    return wasHome(f, awayId) ? home > 0 : away > 0;
  }).length || 0;
  const awayScoredPct = safeDiv(awayScored, awayLastFive?.length || 1);

  const recentBtts = homeScoredPct * awayScoredPct;

  let h2hBtts = 0.5;
  if (h2h && h2h.length > 0) {
    const bothScored = h2h.filter(f => {
      const { home, away } = getGoals(f);
      return home > 0 && away > 0;
    }).length;
    h2hBtts = safeDiv(bothScored, h2h.length);
  }

  // 60% recent form, 40% H2H
  const weighted = recentBtts * 0.6 + h2hBtts * 0.4;
  return pct(weighted);
}

// ===================== MATCH WINNER =====================

export function calculateWinProbabilities(homeLastFive, awayLastFive, h2h, homeId, awayId) {
  const homeForm = calculateForm(homeLastFive, homeId);
  const awayForm = calculateForm(awayLastFive, awayId);

  const homeFormPct = safeDiv(homeForm.points, homeForm.maxPoints || 15);
  const awayFormPct = safeDiv(awayForm.points, awayForm.maxPoints || 15);

  const h2hSummary = calculateH2HSummary(h2h, homeId, awayId);
  const h2hTotal = h2hSummary.total || 1;
  const h2hHomePct = safeDiv(h2hSummary.homeWins, h2hTotal);
  const h2hDrawPct = safeDiv(h2hSummary.draws, h2hTotal);
  const h2hAwayPct = safeDiv(h2hSummary.awayWins, h2hTotal);

  const homeBonus = 0.08;

  let homeRaw = homeFormPct * 0.5 + h2hHomePct * 0.3 + homeBonus + 0.1;
  let drawRaw = (1 - homeFormPct - awayFormPct + 1) / 3 * 0.5 + h2hDrawPct * 0.3 + 0.1;
  let awayRaw = awayFormPct * 0.5 + h2hAwayPct * 0.3 + 0.05;

  const total = homeRaw + drawRaw + awayRaw;
  const home = pct(homeRaw / total);
  const draw = pct(drawRaw / total);
  const away = 100 - home - draw;

  return {
    home: Math.max(5, home),
    draw: Math.max(5, draw),
    away: Math.max(5, away),
  };
}

// ===================== OVER/UNDER GOALS =====================

export function calculateOverUnder(homeLastFive, awayLastFive, homeId, awayId) {
  const homeGoals = calculateGoalAverages(homeLastFive, homeId);
  const awayGoals = calculateGoalAverages(awayLastFive, awayId);
  const expectedTotal = homeGoals.avgScored + awayGoals.avgScored;

  const over15 = pct(Math.min(0.95, 1 - Math.exp(-expectedTotal) * (1 + expectedTotal)));
  const over25 = pct(Math.min(0.90, 1 - Math.exp(-expectedTotal) * (1 + expectedTotal + expectedTotal * expectedTotal / 2)));
  const over35 = pct(Math.min(0.85, 1 - Math.exp(-expectedTotal) * (1 + expectedTotal + expectedTotal * expectedTotal / 2 + Math.pow(expectedTotal, 3) / 6)));

  return {
    expectedTotal: +expectedTotal.toFixed(2),
    over15: clamp(over15, 5, 95),
    over25: clamp(over25, 5, 95),
    over35: clamp(over35, 5, 95),
    under15: clamp(100 - over15, 5, 95),
    under25: clamp(100 - over25, 5, 95),
    under35: clamp(100 - over35, 5, 95),
  };
}

// ===================== CORNER PROBABILITIES =====================

export function calculateCornerProbabilities(avgTotal) {
  if (!avgTotal || avgTotal <= 0) return { over85: 50, over95: 35, over105: 20 };
  const lambda = avgTotal;
  return {
    over85: clamp(pct(1 - poissonCDF(8, lambda)), 5, 95),
    over95: clamp(pct(1 - poissonCDF(9, lambda)), 5, 95),
    over105: clamp(pct(1 - poissonCDF(10, lambda)), 5, 95),
  };
}

// ===================== CARD PROBABILITIES =====================

export function calculateCardProbabilities(avgTotal) {
  const lambda = avgTotal || 4;
  return {
    over25: clamp(pct(1 - poissonCDF(2, lambda)), 5, 95),
    over35: clamp(pct(1 - poissonCDF(3, lambda)), 5, 95),
    over45: clamp(pct(1 - poissonCDF(4, lambda)), 5, 95),
  };
}

// ===================== POISSON =====================

function poissonCDF(k, lambda) {
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += Math.pow(lambda, i) * Math.exp(-lambda) / factorial(i);
  }
  return Math.min(1, sum);
}

function factorial(n) {
  if (n <= 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

// ===================== FULL ANALYSIS =====================

export function computeAllProbabilities(analysis) {
  const { h2h, homeLastFive, awayLastFive, homeId, awayId, cornerCardData } = analysis;

  const btts = calculateBTTS(homeLastFive, awayLastFive, h2h, homeId, awayId);
  const winner = calculateWinProbabilities(homeLastFive, awayLastFive, h2h, homeId, awayId);
  const overUnder = calculateOverUnder(homeLastFive, awayLastFive, homeId, awayId);
  const homeGoals = calculateGoalAverages(homeLastFive, homeId);
  const awayGoals = calculateGoalAverages(awayLastFive, awayId);
  const h2hGoals = calculateH2HGoalAvg(h2h, homeId);
  const h2hSummary = calculateH2HSummary(h2h, homeId, awayId);
  const homeForm = calculateForm(homeLastFive, homeId);
  const awayForm = calculateForm(awayLastFive, awayId);

  // Use real corner/card data if available
  const ccd = cornerCardData || {};
  const cornerAvg = ccd.hasRealData ? ccd.totalCornersAvg : 10.2;
  const cardAvg = ccd.hasRealData ? ccd.totalCardsAvg : 4.2;

  const corners = calculateCornerProbabilities(cornerAvg);
  const cards = calculateCardProbabilities(cardAvg);

  return {
    btts,
    bttsNo: 100 - btts,
    winner,
    overUnder,
    homeGoals,
    awayGoals,
    h2hGoals,
    h2hSummary,
    homeForm,
    awayForm,
    cards,
    corners,
    cornerAvg,
    cardAvg,
    cornerCardData: ccd,
  };
}
