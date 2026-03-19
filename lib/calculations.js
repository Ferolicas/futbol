// ===================== PROBABILITY CALCULATIONS =====================
// All functions are pure — no side effects, no API calls

function safeDiv(a, b) { return b > 0 ? a / b : 0; }
function clamp(val, min = 0, max = 100) { return Math.max(min, Math.min(max, val)); }
function pct(val) { return Math.round(clamp(val * 100, 5, 95)); }

function getGoals(fixture) {
  const home = fixture?.goals?.home ?? fixture?.score?.fulltime?.home ?? 0;
  const away = fixture?.goals?.away ?? fixture?.score?.fulltime?.away ?? 0;
  return { home, away };
}

function wasHome(fixture, teamId) {
  return fixture?.teams?.home?.id === teamId;
}

// ===================== NORMAL DISTRIBUTION CDF =====================

/**
 * Approximate the standard normal CDF using the Abramowitz & Stegun formula.
 * Accuracy within ~1.5e-7 for all z.
 */
function normalCDF(z) {
  if (z < -8) return 0;
  if (z > 8) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/**
 * P(X > threshold) using normal distribution with given mean and variance.
 * Returns a value between 0 and 1.
 */
function normalOverProb(threshold, mean, variance) {
  if (variance <= 0) return mean > threshold ? 1 : 0;
  const sd = Math.sqrt(variance);
  const z = (threshold - mean) / sd;
  return 1 - normalCDF(z);
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
  return clamp(pct(weighted), 5, 95);
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

  // Normalize to percentages, clamp each to [5, 95]
  let home = clamp(pct(homeRaw / total), 5, 95);
  let draw = clamp(pct(drawRaw / total), 5, 95);
  let away = clamp(pct(awayRaw / total), 5, 95);

  // Renormalize so they sum to exactly 100
  const sumClamped = home + draw + away;
  home = Math.round(home / sumClamped * 100);
  draw = Math.round(draw / sumClamped * 100);
  away = 100 - home - draw;

  // Final safety clamp after renormalization
  home = clamp(home, 5, 95);
  draw = clamp(draw, 5, 95);
  away = clamp(away, 5, 95);

  return { home, draw, away };
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
// Corners are overdispersed relative to Poisson. Empirical data shows that
// "over" thresholds hit more often than Poisson predicts, because corners
// cluster (one team pressing generates multiple corners in short spans).
//
// Approach: Poisson base probability with a 1.25x overdispersion boost,
// which aligns with observed hit rates (e.g., avgTotal=10.2 gives ~86% for
// over 8.5 instead of the raw Poisson 69%).

const CORNER_OVERDISPERSION = 1.25;

export function calculateCornerProbabilities(avgTotal) {
  if (!avgTotal || avgTotal <= 0) return { over85: 50, over95: 35, over105: 20 };

  const lambda = avgTotal;
  const rawOver85 = 1 - poissonCDF(8, lambda);
  const rawOver95 = 1 - poissonCDF(9, lambda);
  const rawOver105 = 1 - poissonCDF(10, lambda);

  return {
    over85: clamp(Math.round(rawOver85 * CORNER_OVERDISPERSION * 100), 5, 95),
    over95: clamp(Math.round(rawOver95 * CORNER_OVERDISPERSION * 100), 5, 95),
    over105: clamp(Math.round(rawOver105 * CORNER_OVERDISPERSION * 100), 5, 95),
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

// ===================== PER-TEAM PROBABILITIES =====================

/**
 * Calculate per-team over/under probabilities for corners, cards, and goals.
 *
 * Corners use normal distribution with variance = mean * 1.5 (overdispersed).
 * Cards use Poisson CDF.
 * Goals use Poisson CDF.
 *
 * @param {number} homeCorners - avg corners per match for home team
 * @param {number} awayCorners - avg corners per match for away team
 * @param {number} homeCards   - avg cards per match for home team
 * @param {number} awayCards   - avg cards per match for away team
 * @param {number} homeGoals   - avg goals per match for home team
 * @param {number} awayGoals   - avg goals per match for away team
 */
export function calculatePerTeamProbabilities(homeCorners, awayCorners, homeCards, awayCards, homeGoals, awayGoals) {
  function cornerOverProbs(mean) {
    if (!mean || mean <= 0) return { over05: 50, over15: 35, over25: 20, over35: 10, over45: 5, over55: 5 };
    const lambda = mean;
    return {
      over05: clamp(Math.round((1 - poissonCDF(0, lambda)) * CORNER_OVERDISPERSION * 100), 5, 95),
      over15: clamp(Math.round((1 - poissonCDF(1, lambda)) * CORNER_OVERDISPERSION * 100), 5, 95),
      over25: clamp(Math.round((1 - poissonCDF(2, lambda)) * CORNER_OVERDISPERSION * 100), 5, 95),
      over35: clamp(Math.round((1 - poissonCDF(3, lambda)) * CORNER_OVERDISPERSION * 100), 5, 95),
      over45: clamp(Math.round((1 - poissonCDF(4, lambda)) * CORNER_OVERDISPERSION * 100), 5, 95),
      over55: clamp(Math.round((1 - poissonCDF(5, lambda)) * CORNER_OVERDISPERSION * 100), 5, 95),
    };
  }

  function cardOverProbs(mean) {
    const lambda = mean || 2;
    return {
      over05: clamp(pct(1 - poissonCDF(0, lambda)), 5, 95),
      over15: clamp(pct(1 - poissonCDF(1, lambda)), 5, 95),
      over25: clamp(pct(1 - poissonCDF(2, lambda)), 5, 95),
      over35: clamp(pct(1 - poissonCDF(3, lambda)), 5, 95),
    };
  }

  function goalOverProbs(mean) {
    const lambda = mean || 1;
    return {
      over05: clamp(pct(1 - poissonCDF(0, lambda)), 5, 95),
      over15: clamp(pct(1 - poissonCDF(1, lambda)), 5, 95),
      over25: clamp(pct(1 - poissonCDF(2, lambda)), 5, 95),
    };
  }

  return {
    home: {
      corners: cornerOverProbs(homeCorners),
      cards: cardOverProbs(homeCards),
      goals: goalOverProbs(homeGoals),
    },
    away: {
      corners: cornerOverProbs(awayCorners),
      cards: cardOverProbs(awayCards),
      goals: goalOverProbs(awayGoals),
    },
  };
}

// ===================== GOAL TIMING PROBABILITIES =====================

/**
 * Calculate probability of a goal in each 15-minute period.
 *
 * @param {object} goalTimingData
 *   {
 *     home: { '0-15': count, '15-30': count, ..., '75-90': count, totalMatches: n },
 *     away: { '0-15': count, '15-30': count, ..., '75-90': count, totalMatches: n }
 *   }
 *
 * @returns {object} Per-team and combined probabilities with highlight flags
 */
export function calculateGoalTimingProbabilities(goalTimingData) {
  const periods = ['0-15', '15-30', '30-45', '45-60', '60-75', '75-90'];

  function computeTeamTiming(teamData) {
    if (!teamData || !teamData.totalMatches || teamData.totalMatches <= 0) {
      return periods.map(period => ({
        period,
        probability: 0,
        highlight: false,
      }));
    }
    const n = teamData.totalMatches;
    return periods.map(period => {
      // goalTimingData stores periods as { periods: { '0-15': { scored, conceded }, ... } }
      const periodData = teamData.periods?.[period];
      const count = periodData ? (periodData.scored || 0) + (periodData.conceded || 0) : (teamData[period] || 0);
      const prob = clamp(Math.round((count / n) * 100), 5, 95);
      return {
        period,
        probability: prob,
        highlight: prob > 70,
      };
    });
  }

  const home = computeTeamTiming(goalTimingData?.home);
  const away = computeTeamTiming(goalTimingData?.away);

  // Combined: probability that at least one team scores in a period
  // P(combined) = 1 - (1 - P_home) * (1 - P_away)
  const combined = periods.map((period, i) => {
    const pH = home[i].probability / 100;
    const pA = away[i].probability / 100;
    const pCombined = clamp(Math.round((1 - (1 - pH) * (1 - pA)) * 100), 5, 95);
    return {
      period,
      probability: pCombined,
      highlight: pCombined > 70,
    };
  });

  return { home, away, combined };
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
  const { h2h, homeLastFive, awayLastFive, homeId, awayId, cornerCardData, goalTimingData } = analysis;

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

  // Per-team corner/card/goal probabilities
  const homeCornerAvg = ccd.hasRealData ? (ccd.homeCornersAvg || cornerAvg / 2) : 5.1;
  const awayCornerAvg = ccd.hasRealData ? (ccd.awayCornersAvg || cornerAvg / 2) : 5.1;
  const homeCardAvg = ccd.hasRealData ? (ccd.homeCardsAvg || cardAvg / 2) : 2.1;
  const awayCardAvg = ccd.hasRealData ? (ccd.awayCardsAvg || cardAvg / 2) : 2.1;

  const perTeam = calculatePerTeamProbabilities(
    homeCornerAvg, awayCornerAvg,
    homeCardAvg, awayCardAvg,
    homeGoals.avgScored, awayGoals.avgScored
  );

  // Goal timing probabilities (if data provided)
  const goalTiming = goalTimingData
    ? calculateGoalTimingProbabilities(goalTimingData)
    : null;

  return {
    btts: clamp(btts, 5, 95),
    bttsNo: clamp(100 - btts, 5, 95),
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
    perTeam,
    goalTiming,
  };
}
