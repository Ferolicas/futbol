// ===================== PROBABILITY CALCULATIONS =====================
// Pure functions — no side effects, no API calls.
// Model: Recency-weighted Dixon-Coles bivariate Poisson.
// All probabilities are derived from lambdaHome / lambdaAway — no hardcoded weights.

import { resolveHalfSplit1H } from './league-half-factors.js';

/* ── Generic helpers ──────────────────────────────────────────────────────── */
function safeDiv(a, b) { return b > 0 ? a / b : 0; }
function clamp(val, min = 0, max = 100) { return Math.max(min, Math.min(max, val)); }
function pct(val) { return Math.round(clamp(val * 100, 5, 95)); }

function getGoals(f) {
  const home = f?.goals?.home ?? f?.score?.fulltime?.home ?? 0;
  const away = f?.goals?.away ?? f?.score?.fulltime?.away ?? 0;
  return { home, away };
}

function wasHome(f, teamId) { return f?.teams?.home?.id === teamId; }

/* ── Statistical distributions ───────────────────────────────────────────── */

/**
 * Abramowitz & Stegun polynomial approximation of the standard normal CDF.
 * Accuracy ≈ 1.5e-7 for all z.
 */
function normalCDF(z) {
  if (z < -8) return 0;
  if (z > 8)  return 1;
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function factorial(n) {
  if (n <= 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

/** P(X ≤ k) for Poisson(λ) */
function logGamma(z) {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function negBinomPMF(k, r, p) {
  if (k < 0 || r <= 0 || p <= 0 || p >= 1) return 0;
  return Math.exp(
    logGamma(k + r) - logGamma(r) - logGamma(k + 1) + r * Math.log(p) + k * Math.log(1 - p)
  );
}

function negBinomCDF(k, r, p) {
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += negBinomPMF(i, r, p);
  return Math.min(1, sum);
}

// Survival probability P(X > k) for a count with mean μ and overdispersion od (variance/mean).
// Uses Poisson when od ≈ 1 and Negative Binomial otherwise. Replaces the buggy Poisson*od scaling.
function overSurvival(k, mean, od) {
  if (mean <= 0) return 0;
  if (od <= 1.05) return 1 - poissonCDF(k, mean);
  const r = mean / (od - 1);
  const p = 1 / od;
  return 1 - negBinomCDF(k, r, p);
}

function poissonCDF(k, lambda) {
  if (lambda <= 0) return 1;
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += Math.pow(lambda, i) * Math.exp(-lambda) / factorial(i);
  return Math.min(1, sum);
}

/** P(X = k) for Poisson(λ) */
function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.pow(lambda, k) * Math.exp(-lambda) / factorial(k);
}

/* ── Recency weighting ────────────────────────────────────────────────────── */

/**
 * Exponential decay weights for n matches (index 0 = oldest, n-1 = newest).
 * decayFactor=0.75 → each older match is worth 75% of the next newer one.
 * Returns weights normalized to sum to 1.
 */
function recencyWeights(n, decayFactor = 0.75) {
  if (n <= 0) return [];
  const raw = Array.from({ length: n }, (_, i) => Math.pow(decayFactor, n - 1 - i));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map(w => w / sum);
}

/**
 * Filter last5 to same-league matches when enough data exists.
 * Threshold: at least `minSame` matches in the same league.
 * Falls back to all competitions if below threshold.
 */
function filterByLeague(lastFive, targetLeagueId, minSame = 3) {
  if (!targetLeagueId || !lastFive?.length) return lastFive || [];
  const same = lastFive.filter(f => f.league?.id === targetLeagueId);
  return same.length >= minSame ? same : lastFive;
}

/**
 * Recency-weighted average goals scored/conceded per match.
 * Optionally filters to same-league matches before computing.
 */
function weightedGoalRate(lastFive, teamId, type = 'scored', leagueId = null) {
  const pool = leagueId ? filterByLeague(lastFive, leagueId) : (lastFive || []);
  const finished = pool.filter(f => {
    const { home, away } = getGoals(f);
    return home != null && away != null;
  });
  if (finished.length === 0) return 1.2; // cross-league average fallback

  const w = recencyWeights(finished.length);
  let total = 0;
  finished.forEach((f, i) => {
    const { home, away } = getGoals(f);
    const isHome = wasHome(f, teamId);
    total += (type === 'scored' ? (isHome ? home : away) : (isHome ? away : home)) * w[i];
  });
  return Math.max(0.1, total);
}

/**
 * Derive the home advantage multiplier from a team's own home vs away scoring.
 * Blended 35% data-driven + 65% empirical prior (1.25x from established research)
 * to avoid overfitting with small samples (≤5 matches).
 */
function computeHomeAdv(lastFive, teamId) {
  const homeGames = (lastFive || []).filter(f => wasHome(f, teamId) && getGoals(f).home != null);
  const awayGames = (lastFive || []).filter(f => !wasHome(f, teamId) && getGoals(f).away != null);
  if (homeGames.length === 0 || awayGames.length === 0) return 1.25;
  const homeRate = homeGames.reduce((s, f) => s + getGoals(f).home, 0) / homeGames.length;
  const awayRate = awayGames.reduce((s, f) => s + getGoals(f).away, 0) / awayGames.length;
  if (awayRate <= 0) return 1.25;
  const dataDriven = homeRate / awayRate;
  return Math.max(0.8, Math.min(2.0, dataDriven * 0.35 + 1.25 * 0.65));
}

/* ── Expected Goals (λ) Model ─────────────────────────────────────────────── */

/**
 * Compute λ_home and λ_away.
 *
 * Formula:
 *   λ_home = √(homeAttack × awayDefense) × homeAdv × posAdj
 *   λ_away = √(awayAttack × homeDefense) × posAdj⁻¹
 *
 * Where:
 *   homeAttack / awayAttack  = recency-weighted goals scored (same-league preferred)
 *   homeDefense / awayDefense = recency-weighted goals conceded (same-league preferred)
 *   homeAdv    = data-derived home advantage (blended with 1.25x prior)
 *   posAdj     = league standing quality factor (±12%, log-scaled, max 4× ratio)
 *   H2H        = blended at 0–25% proportional to sample size
 *
 * @param {Array}  homeLastFive
 * @param {Array}  awayLastFive
 * @param {Array}  h2h
 * @param {number} homeId
 * @param {number} awayId
 * @param {number|null} homePosition  — league table rank (1-based)
 * @param {number|null} awayPosition  — league table rank (1-based)
 * @param {number|null} leagueId      — current fixture's league ID
 * @returns {{ lambdaHome: number, lambdaAway: number }}
 */
export function computeExpectedGoals(
  homeLastFive, awayLastFive, h2h,
  homeId, awayId,
  homePosition, awayPosition,
  leagueId
) {
  const homeAttack  = weightedGoalRate(homeLastFive, homeId, 'scored',   leagueId);
  const awayConcede = weightedGoalRate(awayLastFive, awayId, 'conceded', leagueId);
  const awayAttack  = weightedGoalRate(awayLastFive, awayId, 'scored',   leagueId);
  const homeConcede = weightedGoalRate(homeLastFive, homeId, 'conceded', leagueId);

  // Geometric mean blends team attack with opponent defensive weakness equally
  const formHome = Math.sqrt(homeAttack * awayConcede);
  const formAway = Math.sqrt(awayAttack * homeConcede);

  const homeAdv     = computeHomeAdv(homeLastFive, homeId);
  const adjFormHome = formHome * homeAdv;

  // League position adjustment: capped at ±12%, log-scaled over a 4× ratio range
  let posAdjHome = 1.0, posAdjAway = 1.0;
  if (homePosition > 0 && awayPosition > 0) {
    const ratio = Math.max(0.25, Math.min(4, awayPosition / homePosition));
    const adj   = 1 + (Math.log(ratio) / Math.log(4)) * 0.12;
    posAdjHome  = adj;
    posAdjAway  = 1 / adj;
  }

  const adjHome = adjFormHome * posAdjHome;
  const adjAway = formAway   * posAdjAway;

  // H2H contribution: proportional to sample size, capped at 25%
  const h2hCount  = h2h?.length || 0;
  const h2hWeight = h2hCount >= 2 ? Math.min(h2hCount / 10 * 0.25, 0.25) : 0;

  let lambdaHome, lambdaAway;
  if (h2hWeight > 0) {
    const h2hGoals = calculateH2HGoalAvg(h2h, homeId);
    lambdaHome = adjHome * (1 - h2hWeight) + h2hGoals.homeAvg * h2hWeight;
    lambdaAway = adjAway * (1 - h2hWeight) + h2hGoals.awayAvg * h2hWeight;
  } else {
    lambdaHome = adjHome;
    lambdaAway = adjAway;
  }

  return {
    lambdaHome: Math.max(0.3, Math.min(5.0, lambdaHome)),
    lambdaAway: Math.max(0.3, Math.min(5.0, lambdaAway)),
  };
}

/* ── Dixon-Coles correction ───────────────────────────────────────────────── */

/**
 * Low-score correction factor from Dixon & Coles (1997).
 * Corrects Poisson's underestimation of 0-0, 1-0, 0-1, and 1-1 results.
 * ρ = 0.10 is the empirically established value from the original paper.
 */
function dcTau(h, a, lH, lA, rho = 0.10) {
  if (h === 0 && a === 0) return Math.max(0, 1 - rho * lH * lA);
  if (h === 1 && a === 0) return Math.max(0, 1 + rho * lA);
  if (h === 0 && a === 1) return Math.max(0, 1 + rho * lH);
  if (h === 1 && a === 1) return Math.max(0, 1 - rho);
  return 1;
}

/* ── Win Probabilities ────────────────────────────────────────────────────── */

/**
 * Compute P(home win), P(draw), P(away win) via Dixon-Coles bivariate Poisson.
 * Sums scorelines up to 10 goals per team (covers >99.99% of real outcomes).
 */
export function calculateWinProbabilitiesFromLambda(lambdaHome, lambdaAway) {
  const MAX = 10;
  let pH = 0, pD = 0, pA = 0;

  for (let h = 0; h <= MAX; h++) {
    for (let a = 0; a <= MAX; a++) {
      const p = poissonPMF(h, lambdaHome)
              * poissonPMF(a, lambdaAway)
              * dcTau(h, a, lambdaHome, lambdaAway);
      if (h > a) pH += p;
      else if (h === a) pD += p;
      else pA += p;
    }
  }

  const total = pH + pD + pA;
  let home = clamp(Math.round(pH / total * 100), 5, 95);
  let draw = clamp(Math.round(pD / total * 100), 5, 95);
  let away = clamp(Math.round(pA / total * 100), 5, 95);
  const s  = home + draw + away;
  home = Math.round(home / s * 100);
  draw = Math.round(draw / s * 100);
  away = 100 - home - draw;
  return { home, draw, away };
}

// Legacy alias — keeps signature from old code that passed lastFive arrays
export function calculateWinProbabilities(homeLastFive, awayLastFive, h2h, homeId, awayId, homePosition, awayPosition, leagueId) {
  const { lambdaHome, lambdaAway } = computeExpectedGoals(
    homeLastFive, awayLastFive, h2h, homeId, awayId, homePosition, awayPosition, leagueId
  );
  return calculateWinProbabilitiesFromLambda(lambdaHome, lambdaAway);
}

/* ── BTTS ─────────────────────────────────────────────────────────────────── */

/**
 * P(BTTS) = P(home ≥ 1) × P(away ≥ 1) from Poisson,
 * blended with H2H observed BTTS frequency (0–30% weight by sample size).
 */
export function calculateBTTS(homeLastFive, awayLastFive, h2h, homeId, awayId, lambdaHome, lambdaAway) {
  const poissonBtts = (1 - poissonPMF(0, lambdaHome)) * (1 - poissonPMF(0, lambdaAway));

  const h2hCount  = h2h?.length || 0;
  const h2hWeight = h2hCount >= 2 ? Math.min(h2hCount / 10 * 0.3, 0.3) : 0;

  let btts = poissonBtts;
  if (h2hWeight > 0) {
    const bothScored = h2h.filter(f => {
      const { home, away } = getGoals(f);
      return home > 0 && away > 0;
    }).length;
    const h2hBtts = safeDiv(bothScored, h2hCount);
    btts = poissonBtts * (1 - h2hWeight) + h2hBtts * h2hWeight;
  }

  return clamp(pct(btts), 5, 95);
}

/* ── Over/Under ───────────────────────────────────────────────────────────── */

/**
 * P(total goals > k) using total Poisson λ = λ_home + λ_away.
 * (Sum of two independent Poisson variables is Poisson with sum parameter.)
 */
export function calculateOverUnder(homeLastFive, awayLastFive, homeId, awayId, lambdaHome, lambdaAway) {
  // Accept pre-computed lambdas; fall back to simple weighted rates if not provided
  const lH = lambdaHome ?? weightedGoalRate(homeLastFive, homeId, 'scored');
  const lA = lambdaAway ?? weightedGoalRate(awayLastFive, awayId, 'scored');
  const λ  = lH + lA;

  return {
    expectedTotal: +λ.toFixed(2),
    over15:  clamp(pct(1 - poissonCDF(1, λ)), 5, 95),
    over25:  clamp(pct(1 - poissonCDF(2, λ)), 5, 95),
    over35:  clamp(pct(1 - poissonCDF(3, λ)), 5, 95),
    under15: clamp(pct(poissonCDF(1, λ)), 5, 95),
    under25: clamp(pct(poissonCDF(2, λ)), 5, 95),
    under35: clamp(pct(poissonCDF(3, λ)), 5, 95),
  };
}

/* ── Corner/Card Overdispersion ───────────────────────────────────────────── */

/**
 * Compute empirical overdispersion from per-match corner/card counts.
 * Index of Dispersion = variance / mean (pure Poisson → ID = 1).
 * Football corners and cards cluster → ID typically 1.1–1.6.
 * Requires ≥3 data points; falls back to 1.2 otherwise.
 */
function computeOverdispersion(perMatchValues) {
  const vals = (perMatchValues || []).filter(v => typeof v === 'number' && isFinite(v));
  if (vals.length < 3) return 1.2;
  const n    = vals.length;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  if (mean <= 0) return 1.2;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  return Math.max(1.0, Math.min(2.0, variance / mean));
}

/* ── Corner Probabilities ─────────────────────────────────────────────────── */

export function calculateCornerProbabilities(avgTotal, perMatchValues) {
  const λ  = avgTotal > 0 ? avgTotal : 10.4;
  const od = computeOverdispersion(perMatchValues);

  return {
    over85:  clamp(Math.round(overSurvival(8,  λ, od) * 100), 5, 95),
    over95:  clamp(Math.round(overSurvival(9,  λ, od) * 100), 5, 95),
    over105: clamp(Math.round(overSurvival(10, λ, od) * 100), 5, 95),
  };
}

/* ── Card Probabilities ───────────────────────────────────────────────────── */

export function calculateCardProbabilities(avgTotal, refereeFactor = 1) {
  // refereeFactor ajusta lambda segun el historico del arbitro asignado.
  // Default 1 = sin efecto (caller no pasa factor o no hay muestra suficiente).
  // El clamp del factor (sample-size minimo, ±20%) se aplica en el caller.
  const baseAvg = avgTotal > 0 ? avgTotal : 3.8;
  const λ = baseAvg * (refereeFactor > 0 ? refereeFactor : 1);
  return {
    over25: clamp(pct(1 - poissonCDF(2, λ)), 5, 95),
    over35: clamp(pct(1 - poissonCDF(3, λ)), 5, 95),
    over45: clamp(pct(1 - poissonCDF(4, λ)), 5, 95),
  };
}

/* ── First-Goal Timing Probabilities ──────────────────────────────────────── */
// P(primer gol del partido antes del minuto t) bajo modelo Poisson homogéneo.
// Si la tasa total de goles es λ_total = λH + λA por 90 min, la tasa por
// minuto es λ_total/90. La probabilidad de que NO haya goles en t minutos es
// exp(-λ_total · t/90). Por tanto P(primer gol ≤ t) = 1 - exp(-λ_total · t/90).
export function calculateFirstGoalProbabilities(lambdaHome, lambdaAway) {
  const λTotal = (lambdaHome || 0) + (lambdaAway || 0);
  if (λTotal <= 0) return { before30: 5, before45: 5 };
  const pBefore = (t) => 1 - Math.exp(-λTotal * (t / 90));
  return {
    before30: clamp(pct(pBefore(30)), 5, 95),
    before45: clamp(pct(pBefore(45)), 5, 95),
  };
}

/* ── Per-Team Probabilities ───────────────────────────────────────────────── */

/**
 * Per-team corner/card/goal over probabilities.
 * Corner overdispersion is derived per-team from empirical per-match data.
 * Goals use the Dixon-Coles λ directly instead of simple averages.
 */
export function calculatePerTeamProbabilities(
  homeCorners, awayCorners,
  homeCards,   awayCards,
  homeGoals,   awayGoals,
  perMatchHomeCorners, perMatchAwayCorners
) {
  const homeCornerOD = computeOverdispersion(perMatchHomeCorners);
  const awayCornerOD = computeOverdispersion(perMatchAwayCorners);

  function cornerOverProbs(mean, od) {
    const λ = mean > 0 ? mean : 5.2;
    return {
      over05: clamp(Math.round(overSurvival(0, λ, od) * 100), 5, 95),
      over15: clamp(Math.round(overSurvival(1, λ, od) * 100), 5, 95),
      over25: clamp(Math.round(overSurvival(2, λ, od) * 100), 5, 95),
      over35: clamp(Math.round(overSurvival(3, λ, od) * 100), 5, 95),
      over45: clamp(Math.round(overSurvival(4, λ, od) * 100), 5, 95),
      over55: clamp(Math.round(overSurvival(5, λ, od) * 100), 5, 95),
    };
  }

  function cardOverProbs(mean) {
    const λ = mean > 0 ? mean : 1.9;
    return {
      over05: clamp(pct(1 - poissonCDF(0, λ)), 5, 95),
      over15: clamp(pct(1 - poissonCDF(1, λ)), 5, 95),
      over25: clamp(pct(1 - poissonCDF(2, λ)), 5, 95),
      over35: clamp(pct(1 - poissonCDF(3, λ)), 5, 95),
    };
  }

  function goalOverProbs(mean) {
    const λ = mean > 0 ? mean : 1.2;
    return {
      over05: clamp(pct(1 - poissonCDF(0, λ)), 5, 95),
      over15: clamp(pct(1 - poissonCDF(1, λ)), 5, 95),
      over25: clamp(pct(1 - poissonCDF(2, λ)), 5, 95),
    };
  }

  return {
    home: {
      corners: cornerOverProbs(homeCorners, homeCornerOD),
      cards:   cardOverProbs(homeCards),
      goals:   goalOverProbs(homeGoals),
    },
    away: {
      corners: cornerOverProbs(awayCorners, awayCornerOD),
      cards:   cardOverProbs(awayCards),
      goals:   goalOverProbs(awayGoals),
    },
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * MERCADOS NUEVOS (shots, fouls, half-specific, asian handicap, most-X)
 * Patron general: count markets siguen Poisson o NegBin (overSurvival);
 * 1X2 sigue Dixon-Coles bivariate Poisson sobre lambdas del periodo;
 * "most X in half" compara medias normalizadas (chi-square style).
 * Todos los inputs son MEDIAS por partido — la conversion a tasa de
 * mitad asume distribucion 45/55 (estandar empirico del modelo Poisson
 * para futbol; la 2H tiene marginalmente mas eventos por fatiga y juego abierto).
 * ────────────────────────────────────────────────────────────────────────── */

// Defaults globales — usados solo cuando el caller no pasa halfSplit1H.
// El split real se resuelve en computeAllProbabilities via
// resolveHalfSplit1H(leagueId, goalTimingData) — ver lib/league-half-factors.js.
// Estas funciones aceptan `halfSplit1H` como parametro opcional; si llaman
// otros consumidores externos sin pasarlo, caen al default razonable.
const DEFAULT_HALF_SPLIT_1H = 0.45;
const DEFAULT_HALF_SPLIT_2H = 0.55;

/** Lineas adaptativas — devuelve thresholds K que el bookmaker SUELE ofrecer
 *  rondeados a .5 alrededor de la media esperada. Genera 3 lineas: una abajo
 *  de la media, una en la media, una arriba. */
function adaptiveLines(mean, count = 3) {
  if (!Number.isFinite(mean) || mean <= 0) return [];
  const center = Math.round(mean * 2) / 2;  // round to nearest .5
  const lines = [];
  for (let i = -Math.floor(count / 2); i <= Math.floor(count / 2); i++) {
    const k = center + i;
    if (k > 0) lines.push(+k.toFixed(1));
  }
  return lines;
}

/* ── Shots totales ──────────────────────────────────────────────────────── */

export function calculateShotProbabilities(avgTotal, perMatchValues) {
  const λ = avgTotal > 0 ? avgTotal : 22; // media liga generica si insufficient data
  const od = computeOverdispersion(perMatchValues);
  const lines = adaptiveLines(λ, 5);
  const out = { _lines: lines, _mean: +λ.toFixed(1), _overdispersion: +od.toFixed(2) };
  for (const k of lines) {
    // overSurvival(k-1) = P(X > k-1) = P(X >= k). Para "Over K.5" el bookmaker
    // significa "≥ ceil(K.5)" — k.5 no es entero asi que k-1.
    const kFloor = Math.floor(k);
    out[`over${String(k).replace('.', '_')}`] = clamp(Math.round(overSurvival(kFloor, λ, od) * 100), 5, 95);
  }
  return out;
}

export function calculatePerTeamShotProbabilities(homeMean, awayMean, perMatchHome, perMatchAway) {
  const buildSide = (mean, perMatch) => {
    const λ = mean > 0 ? mean : 11;
    const od = computeOverdispersion(perMatch);
    const lines = adaptiveLines(λ, 5);
    const o = { _lines: lines, _mean: +λ.toFixed(1) };
    for (const k of lines) {
      o[`over${String(k).replace('.', '_')}`] = clamp(Math.round(overSurvival(Math.floor(k), λ, od) * 100), 5, 95);
    }
    return o;
  };
  return { home: buildSide(homeMean, perMatchHome), away: buildSide(awayMean, perMatchAway) };
}

/* ── Shots on Target totales ────────────────────────────────────────────── */

export function calculateShotsOnTargetProbabilities(avgTotal, perMatchValues) {
  const λ = avgTotal > 0 ? avgTotal : 8.5;
  const od = computeOverdispersion(perMatchValues);
  const lines = adaptiveLines(λ, 5);
  const out = { _lines: lines, _mean: +λ.toFixed(1) };
  for (const k of lines) {
    out[`over${String(k).replace('.', '_')}`] = clamp(Math.round(overSurvival(Math.floor(k), λ, od) * 100), 5, 95);
  }
  return out;
}

/* ── Faltas totales ─────────────────────────────────────────────────────── */

export function calculateFoulProbabilities(avgTotal, perMatchValues) {
  const λ = avgTotal > 0 ? avgTotal : 22;
  const od = computeOverdispersion(perMatchValues);
  const lines = adaptiveLines(λ, 5);
  const out = { _lines: lines, _mean: +λ.toFixed(1) };
  for (const k of lines) {
    out[`over${String(k).replace('.', '_')}`] = clamp(Math.round(overSurvival(Math.floor(k), λ, od) * 100), 5, 95);
  }
  return out;
}

export function calculatePerTeamFoulProbabilities(homeMean, awayMean, perMatchHome, perMatchAway) {
  const buildSide = (mean, perMatch) => {
    const λ = mean > 0 ? mean : 11;
    const od = computeOverdispersion(perMatch);
    const lines = adaptiveLines(λ, 5);
    const o = { _lines: lines, _mean: +λ.toFixed(1) };
    for (const k of lines) {
      o[`over${String(k).replace('.', '_')}`] = clamp(Math.round(overSurvival(Math.floor(k), λ, od) * 100), 5, 95);
    }
    return o;
  };
  return { home: buildSide(homeMean, perMatchHome), away: buildSide(awayMean, perMatchAway) };
}

/* ── Goles por mitad (Over/Under) ───────────────────────────────────────── */

export function calculateHalfGoalsProbabilities(lambdaHome, lambdaAway, halfSplit1H = DEFAULT_HALF_SPLIT_1H) {
  const split1H = (halfSplit1H > 0 && halfSplit1H < 1) ? halfSplit1H : DEFAULT_HALF_SPLIT_1H;
  const split2H = 1 - split1H;
  const λFull = (lambdaHome || 0) + (lambdaAway || 0);
  const λ1H = λFull * split1H;
  const λ2H = λFull * split2H;
  return {
    firstHalf: {
      over05: clamp(pct(1 - poissonCDF(0, λ1H)), 5, 95),
      over15: clamp(pct(1 - poissonCDF(1, λ1H)), 5, 95),
      over25: clamp(pct(1 - poissonCDF(2, λ1H)), 5, 95),
      under05: clamp(pct(poissonCDF(0, λ1H)), 5, 95),
      under15: clamp(pct(poissonCDF(1, λ1H)), 5, 95),
      under25: clamp(pct(poissonCDF(2, λ1H)), 5, 95),
      expected: +λ1H.toFixed(2),
    },
    secondHalf: {
      over05: clamp(pct(1 - poissonCDF(0, λ2H)), 5, 95),
      over15: clamp(pct(1 - poissonCDF(1, λ2H)), 5, 95),
      over25: clamp(pct(1 - poissonCDF(2, λ2H)), 5, 95),
      under05: clamp(pct(poissonCDF(0, λ2H)), 5, 95),
      under15: clamp(pct(poissonCDF(1, λ2H)), 5, 95),
      under25: clamp(pct(poissonCDF(2, λ2H)), 5, 95),
      expected: +λ2H.toFixed(2),
    },
  };
}

/* ── Goles por equipo por mitad ─────────────────────────────────────────── */

export function calculatePerTeamHalfGoalsProbabilities(lambdaHome, lambdaAway, halfSplit1H = DEFAULT_HALF_SPLIT_1H) {
  const split1H = (halfSplit1H > 0 && halfSplit1H < 1) ? halfSplit1H : DEFAULT_HALF_SPLIT_1H;
  const split2H = 1 - split1H;
  const λH1 = (lambdaHome || 0) * split1H;
  const λH2 = (lambdaHome || 0) * split2H;
  const λA1 = (lambdaAway || 0) * split1H;
  const λA2 = (lambdaAway || 0) * split2H;
  const block = (λ) => ({
    over05: clamp(pct(1 - poissonCDF(0, λ)), 5, 95),
    over15: clamp(pct(1 - poissonCDF(1, λ)), 5, 95),
    expected: +λ.toFixed(2),
  });
  return {
    home: { firstHalf: block(λH1), secondHalf: block(λH2) },
    away: { firstHalf: block(λA1), secondHalf: block(λA2) },
  };
}

/* ── 1X2 por mitad ─────────────────────────────────────────────────────── */
// Mismo Dixon-Coles que el partido completo, pero con lambdas escaladas a
// la mitad. La conjuncion DC se mantiene (rho aplica igual: las correcciones
// para 0-0, 1-0, 0-1, 1-1 se concentran en marcadores bajos, mas frecuentes
// en una mitad).

export function calculateHalfWinnerProbabilities(lambdaHome, lambdaAway, halfSplit1H = DEFAULT_HALF_SPLIT_1H) {
  const split1H = (halfSplit1H > 0 && halfSplit1H < 1) ? halfSplit1H : DEFAULT_HALF_SPLIT_1H;
  const split2H = 1 - split1H;
  const half = (lH, lA) => calculateWinProbabilitiesFromLambda(lH, lA);
  return {
    firstHalf:  half(lambdaHome * split1H, lambdaAway * split1H),
    secondHalf: half(lambdaHome * split2H, lambdaAway * split2H),
  };
}

/* ── Asian Handicap ─────────────────────────────────────────────────────── */
// Calcula probabilidad de que el equipo cubra el handicap para cada line.
// Reglas Asian Handicap clasicas:
//   AH integer (ej -1, +1): half-loss/win cuando empata por exactamente 1 gol
//   AH .25 (ej -1.25): split entre -1 y -1.5
//   AH .5  (ej -1.5):  decision limpia
//   AH .75 (ej -1.75): split entre -1.5 y -2
// Devolvemos prob "neta" = P(cubre completo) + 0.5 * P(half-win) — equivalente
// a EV positivo. Para .25 y .75 promedia los dos lados del split.

export function calculateAsianHandicapProbabilities(lambdaHome, lambdaAway, lines = null) {
  const MAX = 10;
  const grid = []; // grid[h][a] = joint prob
  for (let h = 0; h <= MAX; h++) {
    grid[h] = [];
    for (let a = 0; a <= MAX; a++) {
      grid[h][a] = poissonPMF(h, lambdaHome) * poissonPMF(a, lambdaAway) *
                   dcTau(h, a, lambdaHome, lambdaAway);
    }
  }
  const probWithHandicap = (handicap) => {
    // Equivalente a: P(homeGoals + handicap > awayGoals) sumando sobre el grid.
    let win = 0, push = 0, halfWin = 0, halfLoss = 0;
    for (let h = 0; h <= MAX; h++) {
      for (let a = 0; a <= MAX; a++) {
        const diff = h + handicap - a;
        if (Math.abs(diff - Math.round(diff)) < 1e-9) {
          // Integer diff → push (cancel)
          if (diff > 0) win += grid[h][a];
          else if (diff < 0) {/* loss */}
          else push += grid[h][a];
        } else if (Math.abs(diff - Math.round(diff)) > 0.49 && Math.abs(diff - Math.round(diff)) < 0.51) {
          // .5 diff → clean win/loss
          if (diff > 0) win += grid[h][a];
        } else {
          // .25 or .75 → half-win/half-loss (treat as 0.5)
          if (diff > 0) {
            if (diff < 0.5) halfWin += grid[h][a];
            else win += grid[h][a];
          } else if (diff < 0) {
            if (diff > -0.5) halfLoss += grid[h][a];
            // else: full loss (no contribution)
          }
        }
      }
    }
    // Push refund => excluded from numerator/denominator (decimal odds standard)
    const playable = 1 - push;
    if (playable <= 0) return 0.5;
    return (win + 0.5 * halfWin) / playable;
  };

  // Lineas adaptativas: -1.5, -1, -0.5, 0, +0.5, +1, +1.5 desde la perspectiva home.
  // (El usuario puede pedir away handicap negandolas).
  const defaultLines = [-1.5, -1.25, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.25, 1.5];
  const useLines = (lines && lines.length > 0) ? lines : defaultLines;

  const home = {};
  const away = {};
  for (const ln of useLines) {
    const probHome = probWithHandicap(ln);
    home[`h${String(ln).replace('-', 'm').replace('.', '_')}`] = clamp(Math.round(probHome * 100), 5, 95);
    away[`h${String(-ln).replace('-', 'm').replace('.', '_')}`] = clamp(Math.round((1 - probHome) * 100), 5, 95);
  }
  return { home, away, lines: useLines };
}

/* ── Equipo con más X en mitad/partido ──────────────────────────────────── */
// Modelo: cada equipo tiene su media de eventos por periodo (corners 1H,
// shots 2H, fouls partido, etc). Asumimos eventos independientes Poisson
// y calculamos P(homeCount > awayCount) marginalmente. Para empate, contribuye
// al "draw" market. Truncamos en K=30 (cubre >99.9% del soporte para typical
// match counts).

function poissonCompareProb(λH, λA, maxK = 30) {
  // Devuelve { home, draw, away } como prob desnormalizada [0..1].
  if (λH <= 0 && λA <= 0) return { home: 33, draw: 34, away: 33 };
  let pH = 0, pD = 0, pA = 0;
  for (let h = 0; h <= maxK; h++) {
    const probH = poissonPMF(h, λH);
    if (probH < 1e-10) continue;
    for (let a = 0; a <= maxK; a++) {
      const probA = poissonPMF(a, λA);
      if (probA < 1e-10) continue;
      const joint = probH * probA;
      if (h > a) pH += joint;
      else if (h === a) pD += joint;
      else pA += joint;
    }
  }
  const total = pH + pD + pA;
  if (total <= 0) return { home: 33, draw: 34, away: 33 };
  return {
    home: clamp(Math.round((pH / total) * 100), 5, 95),
    draw: clamp(Math.round((pD / total) * 100), 5, 95),
    away: clamp(Math.round((pA / total) * 100), 5, 95),
  };
}

export function calculateMostCornersByPeriod(ccd) {
  if (!ccd) return null;
  return {
    fullMatch: poissonCompareProb(ccd.homeCornersAvg, ccd.awayCornersAvg),
    firstHalf: poissonCompareProb(ccd.homeCornersFor1H || 0, ccd.awayCornersFor1H || 0),
    secondHalf: poissonCompareProb(ccd.homeCornersFor2H || 0, ccd.awayCornersFor2H || 0),
  };
}

export function calculateMostShotsByPeriod(ccd) {
  if (!ccd) return null;
  return {
    fullMatch: poissonCompareProb(ccd.homeShotsAvg, ccd.awayShotsAvg),
    firstHalf: poissonCompareProb(ccd.homeShots1H || 0, ccd.awayShots1H || 0),
    secondHalf: poissonCompareProb(ccd.homeShots2H || 0, ccd.awayShots2H || 0),
  };
}

export function calculateMostFoulsByPeriod(ccd) {
  if (!ccd) return null;
  return {
    fullMatch: poissonCompareProb(ccd.homeFoulsAvg, ccd.awayFoulsAvg),
    firstHalf: poissonCompareProb(ccd.homeFouls1H || 0, ccd.awayFouls1H || 0),
    secondHalf: poissonCompareProb(ccd.homeFouls2H || 0, ccd.awayFouls2H || 0),
  };
}

/* ── Goal Timing ──────────────────────────────────────────────────────────── */

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

/* ── Form / Averages / H2H (display helpers, unchanged) ──────────────────── */

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

/* ── Main Entry Point ─────────────────────────────────────────────────────── */

/**
 * Compute all probabilities for a match.
 * Called server-side (api-football.js) and client-side (analisis/[id]/page.js).
 *
 * Expects analysis to contain:
 *   homeLastFive, awayLastFive, h2h, homeId, awayId,
 *   leagueId, homePosition, awayPosition,
 *   cornerCardData, goalTimingData
 */
export function computeAllProbabilities(analysis) {
  const {
    h2h, homeLastFive, awayLastFive, homeId, awayId,
    cornerCardData, goalTimingData,
    homePosition, awayPosition, leagueId,
    refereeFactor,
  } = analysis;

  // ── 1. Expected goals — foundation for all outcome predictions ──
  const { lambdaHome, lambdaAway } = computeExpectedGoals(
    homeLastFive, awayLastFive, h2h,
    homeId, awayId,
    homePosition, awayPosition,
    leagueId
  );

  // ── 2. Outcome probabilities derived from λ ──
  const winner    = calculateWinProbabilitiesFromLambda(lambdaHome, lambdaAway);
  const overUnder = calculateOverUnder(homeLastFive, awayLastFive, homeId, awayId, lambdaHome, lambdaAway);
  const btts      = calculateBTTS(homeLastFive, awayLastFive, h2h, homeId, awayId, lambdaHome, lambdaAway);

  // ── 3. Display helpers (form, averages) ──
  const homeGoals  = calculateGoalAverages(homeLastFive, homeId);
  const awayGoals  = calculateGoalAverages(awayLastFive, awayId);
  const h2hGoals   = calculateH2HGoalAvg(h2h, homeId);
  const h2hSummary = calculateH2HSummary(h2h, homeId, awayId);
  const homeForm   = calculateForm(homeLastFive, homeId);
  const awayForm   = calculateForm(awayLastFive, awayId);

  // ── 4. Corners and cards — empirical overdispersion ──
  const ccd = cornerCardData || {};
  const allCornersPerMatch = [
    ...(ccd.homeCornersPerMatch || []),
    ...(ccd.awayCornersPerMatch || []),
  ];

  const cornerAvg = ccd.hasRealData ? (ccd.totalCornersAvg || 10.4) : 10.4;
  const cardAvg   = ccd.hasRealData ? (ccd.totalCardsAvg   || 3.8)  : 3.8;

  const corners = calculateCornerProbabilities(cornerAvg, allCornersPerMatch);
  const refFactor = (typeof refereeFactor === 'number' && refereeFactor > 0) ? refereeFactor : 1;
  const cards   = calculateCardProbabilities(cardAvg, refFactor);

  const homeCornerAvg = ccd.hasRealData ? (ccd.homeCornersAvg || cornerAvg / 2) : cornerAvg / 2;
  const awayCornerAvg = ccd.hasRealData ? (ccd.awayCornersAvg || cornerAvg / 2) : cornerAvg / 2;
  const homeCardAvg   = ccd.hasRealData ? (ccd.homeYellowsAvg || cardAvg / 2)   : cardAvg / 2;
  const awayCardAvg   = ccd.hasRealData ? (ccd.awayYellowsAvg || cardAvg / 2)   : cardAvg / 2;

  const perTeam = calculatePerTeamProbabilities(
    homeCornerAvg, awayCornerAvg,
    homeCardAvg,   awayCardAvg,
    lambdaHome,    lambdaAway,   // DC λ used directly for per-team goal probs
    ccd.homeCornersPerMatch,
    ccd.awayCornersPerMatch
  );

  // ── 5. Goal timing ──
  const goalTiming = goalTimingData
    ? calculateGoalTimingProbabilities(goalTimingData)
    : null;

  // ── 6. First-goal probability (deriva de λ, sin datos extra) ──
  const firstGoal = calculateFirstGoalProbabilities(lambdaHome, lambdaAway);

  // ── 7. MERCADOS NUEVOS (cache_version 8) ─────────────────────────────────
  // Per-match arrays para overdispersion empirica
  const shots = ccd.totalShotsAvg > 0
    ? calculateShotProbabilities(ccd.totalShotsAvg, [...(ccd.homeShotsPerMatch || []), ...(ccd.awayShotsPerMatch || [])])
    : null;
  const sot = ccd.totalShotsOnTargetAvg > 0
    ? calculateShotsOnTargetProbabilities(
        ccd.totalShotsOnTargetAvg,
        [...(ccd.homeSotPerMatch || []), ...(ccd.awaySotPerMatch || [])],
      )
    : null;
  const fouls = ccd.totalFoulsAvg > 0
    ? calculateFoulProbabilities(ccd.totalFoulsAvg, [...(ccd.homeFoulsPerMatch || []), ...(ccd.awayFoulsPerMatch || [])])
    : null;
  const perTeamShots = ccd.totalShotsAvg > 0
    ? calculatePerTeamShotProbabilities(ccd.homeShotsAvg, ccd.awayShotsAvg, ccd.homeShotsPerMatch, ccd.awayShotsPerMatch)
    : null;
  const perTeamFouls = ccd.totalFoulsAvg > 0
    ? calculatePerTeamFoulProbabilities(ccd.homeFoulsAvg, ccd.awayFoulsAvg, ccd.homeFoulsPerMatch, ccd.awayFoulsPerMatch)
    : null;

  // 1H/2H goles y ganador — split calibrado por liga + matchup empirico.
  // resolveHalfSplit1H(leagueId, goalTimingData):
  //   - Si el matchup tiene >=10 goles totales en goalTimingData, mezcla
  //     empirico (peso creciente con N) con la media de liga.
  //   - Si no, usa la media de liga (LEAGUE_HALF_FACTORS).
  //   - Default global 0.45 si nada aplica.
  const halfSplit1H = resolveHalfSplit1H(leagueId, goalTimingData);
  const halfGoals        = calculateHalfGoalsProbabilities(lambdaHome, lambdaAway, halfSplit1H);
  const halfWinner       = calculateHalfWinnerProbabilities(lambdaHome, lambdaAway, halfSplit1H);
  const perTeamHalfGoals = calculatePerTeamHalfGoalsProbabilities(lambdaHome, lambdaAway, halfSplit1H);

  // Asian Handicap — siempre disponible
  const asianHandicap = calculateAsianHandicapProbabilities(lambdaHome, lambdaAway);

  // "Equipo con más X en periodo" (corners, shots, fouls)
  const mostCorners = calculateMostCornersByPeriod(ccd);
  const mostShots   = (ccd.totalShotsAvg > 0) ? calculateMostShotsByPeriod(ccd) : null;
  const mostFouls   = (ccd.totalFoulsAvg > 0) ? calculateMostFoulsByPeriod(ccd) : null;

  return {
    lambdaHome, lambdaAway,   // exposed for predictions table and calibration
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
    refereeFactor: refFactor,
    cornerCardData: ccd,
    perTeam,
    goalTiming,
    firstGoal,
    // ── Nuevos (cache_version 8) ──
    shots,                 // {_lines, _mean, over11_5, over12_5, ...}
    sot,                   // shots on target totals
    fouls,                 // faltas totales
    perTeamShots,          // {home, away}
    perTeamFouls,          // {home, away}
    halfGoals,             // {firstHalf:{over05/15/25, under05/15/25}, secondHalf:{...}}
    halfWinner,            // {firstHalf:{home,draw,away}, secondHalf:{home,draw,away}}
    perTeamHalfGoals,      // {home:{firstHalf, secondHalf}, away:{...}}
    halfSplit1H: +halfSplit1H.toFixed(3),  // diagnostico: fraccion 1H usada
    halfSplit2H: +(1 - halfSplit1H).toFixed(3),
    asianHandicap,         // {home:{h-1_5,h-1,...}, away:{...}, lines}
    mostCorners,           // {fullMatch:{home,draw,away}, firstHalf, secondHalf}
    mostShots,
    mostFouls,
  };
}
