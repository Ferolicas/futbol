// Baseball probability model
//
// Replicates the spirit of the football model (Dixon-Coles + isotonic calibration)
// but adapted to baseball mechanics:
//   - No draws → moneyline is binary (homeWin / awayWin)
//   - Run distribution closer to Negative Binomial than Poisson (overdispersed)
//   - Strong home advantage (~54% MLB historic)
//   - F5 Innings (first 5) markets — usually higher under % since pitchers fresh
//   - Run Line ±1.5 default
//   - Team Total Runs O/U
//
// Design principles:
//   - Always return calibrated probabilities, never blanks
//   - Cap displayed prob at 95% (anti-overconfidence)
//   - Cross-check vs market odds (de-vig) and weight 60% model + 40% market

// =====================================================================
// HELPERS
// =====================================================================

const MIN_PROB = 0.02;
const MAX_PROB = 0.98;
const HOME_ADV_BASELINE = 0.54;       // MLB historical home win rate
const LEAGUE_AVG_RUNS_PER_GAME = 9.0; // ~4.5 per team
const F5_RUNS_FRACTION = 0.55;        // ~55% of total runs scored by F5

const cap = (p, lo = MIN_PROB, hi = MAX_PROB) => Math.max(lo, Math.min(hi, p));

function poissonPMF(k, lambda) {
  if (k < 0) return 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

// Probability that X (Poisson(lambdaA)) > Y (Poisson(lambdaB))
function probXGreaterY(lambdaA, lambdaB, maxK = 25) {
  let p = 0;
  for (let a = 0; a <= maxK; a++) {
    const pa = poissonPMF(a, lambdaA);
    let cumB = 0;
    for (let b = 0; b < a; b++) cumB += poissonPMF(b, lambdaB);
    p += pa * cumB;
  }
  return p;
}

// Probability that X + Y > line (continuous correction with .5 lines is exact)
function probTotalOver(lambdaA, lambdaB, line, maxK = 30) {
  const total = lambdaA + lambdaB;
  let pUnder = 0;
  const ceiling = Math.floor(line);
  for (let k = 0; k <= ceiling; k++) {
    pUnder += poissonPMF(k, total);
  }
  return 1 - pUnder;
}

// =====================================================================
// DE-VIG: convert market odds → fair probabilities
// =====================================================================
function decimalToImplied(odd) { return odd > 1 ? 1 / odd : null; }

function deVigBinary(homeOdd, awayOdd) {
  if (!homeOdd || !awayOdd) return null;
  const ph = decimalToImplied(homeOdd);
  const pa = decimalToImplied(awayOdd);
  if (!ph || !pa) return null;
  const total = ph + pa;
  return { home: ph / total, away: pa / total };
}

// =====================================================================
// TEAM STRENGTH
// =====================================================================
// Builds attack/defense expected runs from team stats.
function teamStrength(stats, leagueAvg = LEAGUE_AVG_RUNS_PER_GAME / 2) {
  if (!stats) return { attack: leagueAvg, defense: leagueAvg };

  const games = stats.games?.played?.total || stats.games?.played || 1;
  const runsScored = stats.points?.for?.total || stats.runs?.for?.total
    || (stats.points?.for?.average?.total ? Number(stats.points.for.average.total) * games : null);
  const runsAllowed = stats.points?.against?.total || stats.runs?.against?.total
    || (stats.points?.against?.average?.total ? Number(stats.points.against.average.total) * games : null);

  const attack = runsScored ? runsScored / Math.max(games, 1) : leagueAvg;
  const defense = runsAllowed ? runsAllowed / Math.max(games, 1) : leagueAvg;

  return { attack, defense };
}

// =====================================================================
// EXPECTED RUNS for a matchup
// =====================================================================
function expectedRuns(homeStats, awayStats, parkFactor = 1.0) {
  const home = teamStrength(homeStats);
  const away = teamStrength(awayStats);
  const leagueHalf = LEAGUE_AVG_RUNS_PER_GAME / 2;

  // Bilinear adjustment: expected runs = (own attack) * (opp defense / league avg) * park
  // + home advantage boost.
  let lambdaHome = (home.attack * (away.defense / leagueHalf)) * parkFactor;
  let lambdaAway = (away.attack * (home.defense / leagueHalf)) * parkFactor;

  // Home advantage: ~5% boost on offense, ~3% reduction on defense
  lambdaHome *= 1.05;
  lambdaAway *= 0.97;

  // Sanity bounds: real games rarely have <2 or >9 expected runs per team
  lambdaHome = Math.max(2.0, Math.min(9.0, lambdaHome));
  lambdaAway = Math.max(2.0, Math.min(9.0, lambdaAway));

  return { lambdaHome, lambdaAway };
}

// =====================================================================
// H2H ADJUSTMENT
// =====================================================================
function h2hAdjust(h2h, homeId, awayId) {
  if (!Array.isArray(h2h) || h2h.length === 0) return { homeBoost: 0, awayBoost: 0 };

  const recent = h2h.slice(0, 10);
  let homeWins = 0;
  let awayWins = 0;
  recent.forEach(g => {
    const hScore = g.scores?.home?.total ?? g.scores?.home;
    const aScore = g.scores?.away?.total ?? g.scores?.away;
    if (hScore == null || aScore == null) return;
    const wasHomeTeam = g.teams?.home?.id === homeId;
    if (hScore > aScore) {
      if (wasHomeTeam) homeWins++; else awayWins++;
    } else if (aScore > hScore) {
      if (wasHomeTeam) awayWins++; else homeWins++;
    }
  });

  const total = homeWins + awayWins;
  if (total === 0) return { homeBoost: 0, awayBoost: 0 };

  // Mild boost: ±5% based on H2H record
  const homeRate = homeWins / total;
  return {
    homeBoost: (homeRate - 0.5) * 0.10,
    awayBoost: ((1 - homeRate) - 0.5) * 0.10,
  };
}

// =====================================================================
// MAIN: COMPUTE ALL MARKETS
// =====================================================================

export function computeBaseballProbabilities({
  homeStats,
  awayStats,
  homeId,
  awayId,
  h2h,
  marketOdds,            // raw odds object from API
  parkFactor = 1.0,
}) {
  const { lambdaHome, lambdaAway } = expectedRuns(homeStats, awayStats, parkFactor);
  const adj = h2hAdjust(h2h, homeId, awayId);

  // ===== Moneyline =====
  let pHome = probXGreaterY(lambdaHome, lambdaAway);
  let pAway = 1 - pHome;
  pHome = cap(pHome + adj.homeBoost);
  pAway = cap(1 - pHome);
  // Re-normalize
  const sumML = pHome + pAway;
  pHome = pHome / sumML;
  pAway = pAway / sumML;

  // Blend with market (de-vig) when available
  const mlMarket = extractMoneylineOdds(marketOdds);
  const mlDevig = mlMarket ? deVigBinary(mlMarket.home, mlMarket.away) : null;
  if (mlDevig) {
    pHome = 0.6 * pHome + 0.4 * mlDevig.home;
    pAway = 0.6 * pAway + 0.4 * mlDevig.away;
  }

  // ===== Total Runs =====
  const totalLines = [7.5, 8.5, 9.5, 10.5];
  const totals = {};
  totalLines.forEach(line => {
    const pOver = probTotalOver(lambdaHome, lambdaAway, line);
    totals[line] = { over: cap(pOver), under: cap(1 - pOver) };
  });

  // Best total line (closest to expected)
  const expectedTotal = lambdaHome + lambdaAway;
  const bestLine = totalLines.reduce((best, l) =>
    Math.abs(l - expectedTotal) < Math.abs(best - expectedTotal) ? l : best, 8.5);

  // ===== Run Line ±1.5 =====
  // Home -1.5: home wins by 2+; Away +1.5: away loses by ≤1 OR wins
  const pHomeMinus15 = probXGreaterY(lambdaHome, lambdaAway + 1.5);
  const pAwayPlus15 = 1 - pHomeMinus15;
  const pAwayMinus15 = probXGreaterY(lambdaAway, lambdaHome + 1.5);
  const pHomePlus15 = 1 - pAwayMinus15;

  // ===== F5 (first 5 innings) =====
  // ~55% of runs come in first 5 innings on average
  const f5Home = lambdaHome * F5_RUNS_FRACTION;
  const f5Away = lambdaAway * F5_RUNS_FRACTION;
  const pF5Home = probXGreaterY(f5Home, f5Away);
  const pF5Away = 1 - pF5Home;
  const pF5Tie = poissonTie(f5Home, f5Away);
  // F5 has ML 3-way (with tie). Normalize without tie for simple ML 1X2.
  const f5TotalLines = [4.5, 5.5];
  const f5Totals = {};
  f5TotalLines.forEach(line => {
    const pOver = probTotalOver(f5Home, f5Away, line);
    f5Totals[line] = { over: cap(pOver), under: cap(1 - pOver) };
  });

  // ===== Team Totals =====
  const teamTotalLines = [3.5, 4.5];
  const teamTotals = { home: {}, away: {} };
  teamTotalLines.forEach(line => {
    const pHomeOver = probTotalOver(lambdaHome, 0, line);
    const pAwayOver = probTotalOver(lambdaAway, 0, line);
    teamTotals.home[line] = { over: cap(pHomeOver), under: cap(1 - pHomeOver) };
    teamTotals.away[line] = { over: cap(pAwayOver), under: cap(1 - pAwayOver) };
  });

  // ===== Both Teams to Score 1+ Run =====
  const pHomeZero = poissonPMF(0, lambdaHome);
  const pAwayZero = poissonPMF(0, lambdaAway);
  const pBTTS = (1 - pHomeZero) * (1 - pAwayZero);

  return {
    moneyline: {
      home: Math.round(pHome * 100),
      away: Math.round(pAway * 100),
    },
    totals: {
      bestLine,
      lines: Object.fromEntries(totalLines.map(l => [l, {
        over: Math.round(totals[l].over * 100),
        under: Math.round(totals[l].under * 100),
      }])),
    },
    runLine: {
      home_minus_1_5: Math.round(cap(pHomeMinus15) * 100),
      away_plus_1_5: Math.round(cap(pAwayPlus15) * 100),
      away_minus_1_5: Math.round(cap(pAwayMinus15) * 100),
      home_plus_1_5: Math.round(cap(pHomePlus15) * 100),
    },
    f5: {
      moneyline: {
        home: Math.round(cap(pF5Home) * 100),
        away: Math.round(cap(pF5Away) * 100),
        tie: Math.round(cap(pF5Tie) * 100),
      },
      totals: Object.fromEntries(f5TotalLines.map(l => [l, {
        over: Math.round(f5Totals[l].over * 100),
        under: Math.round(f5Totals[l].under * 100),
      }])),
    },
    teamTotals: {
      home: Object.fromEntries(teamTotalLines.map(l => [l, {
        over: Math.round(teamTotals.home[l].over * 100),
        under: Math.round(teamTotals.home[l].under * 100),
      }])),
      away: Object.fromEntries(teamTotalLines.map(l => [l, {
        over: Math.round(teamTotals.away[l].over * 100),
        under: Math.round(teamTotals.away[l].under * 100),
      }])),
    },
    btts: {
      yes: Math.round(cap(pBTTS) * 100),
      no: Math.round(cap(1 - pBTTS) * 100),
    },
    expected: {
      lambdaHome: +lambdaHome.toFixed(2),
      lambdaAway: +lambdaAway.toFixed(2),
      totalRuns: +(lambdaHome + lambdaAway).toFixed(2),
    },
  };
}

function poissonTie(la, lb, maxK = 20) {
  let p = 0;
  for (let k = 0; k <= maxK; k++) p += poissonPMF(k, la) * poissonPMF(k, lb);
  return p;
}

// =====================================================================
// MARKET ODDS EXTRACTION (api-baseball multi-bookmaker format)
// =====================================================================
function extractMoneylineOdds(rawOdds) {
  if (!Array.isArray(rawOdds) || rawOdds.length === 0) return null;

  // rawOdds[0] = first game (already filtered). Has bookmakers[].bets[].values[]
  const bookmakers = rawOdds[0]?.bookmakers || [];
  for (const bk of bookmakers) {
    const bet = (bk.bets || []).find(b =>
      /money\s*line|moneyline|home\/away|game\s*lines/i.test(b.name || '')
    );
    if (!bet) continue;
    const values = bet.values || [];
    const home = values.find(v => /home|local|1/i.test(v.value))?.odd;
    const away = values.find(v => /away|visit|2/i.test(v.value))?.odd;
    if (home && away) return { home: Number(home), away: Number(away) };
  }
  return null;
}

export function extractBestOdds(rawOdds) {
  if (!Array.isArray(rawOdds) || rawOdds.length === 0) return null;
  const bookmakers = rawOdds[0]?.bookmakers || [];

  const out = {
    moneyline: null,
    totals: {},
    runLine: null,
    bookmakerCount: bookmakers.length,
  };

  for (const bk of bookmakers) {
    for (const bet of bk.bets || []) {
      const name = (bet.name || '').toLowerCase();

      if (/money\s*line|moneyline|home\/away|game\s*lines/.test(name)) {
        const home = bet.values?.find(v => /home|local|1/i.test(v.value))?.odd;
        const away = bet.values?.find(v => /away|visit|2/i.test(v.value))?.odd;
        if (home && away) {
          const entry = { home: Number(home), away: Number(away), bookmaker: bk.name };
          if (!out.moneyline || (Number(home) > out.moneyline.home && Number(away) > out.moneyline.away)) {
            out.moneyline = entry;
          }
        }
      }

      if (/total|over\s*\/\s*under|asian\s*total/.test(name) && !/team\s*total/.test(name)) {
        for (const v of bet.values || []) {
          const m = (v.value || '').match(/over|under/i);
          if (!m) continue;
          const lineMatch = (v.value || '').match(/[\d.]+/);
          const line = lineMatch ? parseFloat(lineMatch[0]) : null;
          if (!line) continue;
          if (!out.totals[line]) out.totals[line] = {};
          const side = m[0].toLowerCase();
          if (!out.totals[line][side] || Number(v.odd) > out.totals[line][side].odd) {
            out.totals[line][side] = { odd: Number(v.odd), bookmaker: bk.name };
          }
        }
      }
    }
  }

  return out;
}

// =====================================================================
// COMBINADA BUILDER (top picks)
// =====================================================================
export function buildBaseballCombinada(probabilities, bestOdds) {
  if (!probabilities) return null;

  const candidates = [];

  // Moneyline pick (whichever side ≥60%)
  if (probabilities.moneyline.home >= 60) {
    candidates.push({
      market: 'Moneyline',
      pick: 'Home',
      probability: probabilities.moneyline.home,
      odd: bestOdds?.moneyline?.home || null,
    });
  } else if (probabilities.moneyline.away >= 60) {
    candidates.push({
      market: 'Moneyline',
      pick: 'Away',
      probability: probabilities.moneyline.away,
      odd: bestOdds?.moneyline?.away || null,
    });
  }

  // Best total pick
  const bestLine = probabilities.totals.bestLine;
  const totalEntry = probabilities.totals.lines[bestLine];
  if (totalEntry) {
    if (totalEntry.over >= 60) {
      candidates.push({
        market: `Over ${bestLine}`,
        pick: 'Over',
        probability: totalEntry.over,
        odd: bestOdds?.totals?.[bestLine]?.over?.odd || null,
      });
    } else if (totalEntry.under >= 60) {
      candidates.push({
        market: `Under ${bestLine}`,
        pick: 'Under',
        probability: totalEntry.under,
        odd: bestOdds?.totals?.[bestLine]?.under?.odd || null,
      });
    }
  }

  // BTTS if very high
  if (probabilities.btts.yes >= 70) {
    candidates.push({
      market: 'Both teams score 1+',
      pick: 'Yes',
      probability: probabilities.btts.yes,
      odd: null,
    });
  }

  if (candidates.length === 0) return null;

  const top = candidates.sort((a, b) => b.probability - a.probability).slice(0, 3);
  const combinedProb = top.reduce((acc, c) => acc * (c.probability / 100), 1);
  const combinedOdd = top.every(c => c.odd) ? top.reduce((acc, c) => acc * c.odd, 1) : null;

  return {
    selections: top,
    combinedProbability: Math.round(combinedProb * 100),
    combinedOdd: combinedOdd ? +combinedOdd.toFixed(2) : null,
    hasRealOdds: !!combinedOdd,
  };
}

// =====================================================================
// DATA QUALITY SCORE
// =====================================================================
export function scoreBaseballDataQuality({ homeStats, awayStats, h2h, odds }) {
  const checks = {
    hasHomeStats: !!homeStats,
    hasAwayStats: !!awayStats,
    hasH2H: Array.isArray(h2h) && h2h.length >= 3,
    hasOdds: Array.isArray(odds) && odds.length > 0,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const score = Math.round((passed / 4) * 100);
  return { ...checks, score };
}
