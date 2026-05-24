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
 * Corrects Poisson's underestimation of 0-0 and 1-1 (draws). With this
 * tau formulation (τ(1,1)=1-ρ, τ(0,0)=1-ρλμ), ρ must be NEGATIVE to inflate
 * low-score draws. ρ = -0.13 is the value estimated in the original paper;
 * a positive ρ inverts the correction and suppresses draws.
 */
function dcTau(h, a, lH, lA, rho = -0.13) {
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
 * Devuelve rango amplio: 0.5–~7.5 segun la λ. Cada linea tiene over y under.
 */
export function calculateOverUnder(homeLastFive, awayLastFive, homeId, awayId, lambdaHome, lambdaAway) {
  const lH = lambdaHome ?? weightedGoalRate(homeLastFive, homeId, 'scored');
  const lA = lambdaAway ?? weightedGoalRate(awayLastFive, awayId, 'scored');
  const λ  = lH + lA;

  const lines = adaptiveLines(λ, 0, true).filter(k => k >= 0.5);
  const out = { _lines: lines, _mean: +λ.toFixed(2), expectedTotal: +λ.toFixed(2) };

  for (const k of lines) {
    const kFloor = Math.floor(k);
    const overProb  = 1 - poissonCDF(kFloor, λ);
    const underProb = 1 - overProb;
    const keyOver  = `over${String(k).replace('.', '_')}`;
    const keyUnder = `under${String(k).replace('.', '_')}`;
    out[keyOver]  = clamp(Math.round(overProb  * 100), 5, 95);
    out[keyUnder] = clamp(Math.round(underProb * 100), 5, 95);
  }

  // Alias legacy
  out.over15  = out.over1_5  ?? clamp(pct(1 - poissonCDF(1, λ)), 5, 95);
  out.over25  = out.over2_5  ?? clamp(pct(1 - poissonCDF(2, λ)), 5, 95);
  out.over35  = out.over3_5  ?? clamp(pct(1 - poissonCDF(3, λ)), 5, 95);
  out.under15 = out.under1_5 ?? clamp(pct(poissonCDF(1, λ)), 5, 95);
  out.under25 = out.under2_5 ?? clamp(pct(poissonCDF(2, λ)), 5, 95);
  out.under35 = out.under3_5 ?? clamp(pct(poissonCDF(3, λ)), 5, 95);

  return out;
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
// Devuelve rangos amplios: lineas desde 4.5 en adelante (instruccion del producto)
// hasta lo que el modelo permita. Cada linea tiene over_K_5 y under_K_5.
// El filtro real lo aplica combinada al verificar cuota disponible.

export function calculateCornerProbabilities(avgTotal, perMatchValues) {
  const λ  = avgTotal > 0 ? avgTotal : 10.4;
  const od = computeOverdispersion(perMatchValues);

  // Lineas amplias .5: desde 3.5 hasta ceil(λ * 2.5) (cubre 4.5–~26.5)
  const lines = adaptiveLines(λ, 0, true).filter(k => k >= 3.5);
  const out = { _lines: lines, _mean: +λ.toFixed(2), _overdispersion: +od.toFixed(2) };

  for (const k of lines) {
    const kFloor = Math.floor(k);                              // 8.5 → 8
    const overProb  = overSurvival(kFloor, λ, od);             // P(X > 8) = P(X ≥ 9)
    const underProb = 1 - overProb;                            // P(X ≤ 8)
    const keyOver   = `over${String(k).replace('.', '_')}`;    // over8_5
    const keyUnder  = `under${String(k).replace('.', '_')}`;   // under8_5
    out[keyOver]  = clamp(Math.round(overProb  * 100), 5, 95);
    out[keyUnder] = clamp(Math.round(underProb * 100), 5, 95);
  }

  // Alias legacy para no romper consumers viejos (calibration.js, dashboards)
  out.over85  = out.over8_5  ?? clamp(Math.round(overSurvival(8,  λ, od) * 100), 5, 95);
  out.over95  = out.over9_5  ?? clamp(Math.round(overSurvival(9,  λ, od) * 100), 5, 95);
  out.over105 = out.over10_5 ?? clamp(Math.round(overSurvival(10, λ, od) * 100), 5, 95);

  return out;
}

/* ── Card Probabilities ───────────────────────────────────────────────────── */
// Igual que corners: rango amplio desde 1.5 hasta donde la λ permita.
// refereeFactor ajusta lambda segun historico del arbitro (±20%).

export function calculateCardProbabilities(avgTotal, refereeFactor = 1, perMatchValues = []) {
  const baseAvg = avgTotal > 0 ? avgTotal : 3.8;
  const λ  = baseAvg * (refereeFactor > 0 ? refereeFactor : 1);
  const od = computeOverdispersion(perMatchValues);

  const lines = adaptiveLines(λ, 0, true).filter(k => k >= 1.5);
  const out = { _lines: lines, _mean: +λ.toFixed(2), _overdispersion: +od.toFixed(2) };

  for (const k of lines) {
    const kFloor = Math.floor(k);
    const overProb  = od > 1.05 ? overSurvival(kFloor, λ, od) : (1 - poissonCDF(kFloor, λ));
    const underProb = 1 - overProb;
    const keyOver  = `over${String(k).replace('.', '_')}`;
    const keyUnder = `under${String(k).replace('.', '_')}`;
    out[keyOver]  = clamp(Math.round(overProb  * 100), 5, 95);
    out[keyUnder] = clamp(Math.round(underProb * 100), 5, 95);
  }

  // Alias legacy
  out.over25 = out.over2_5 ?? clamp(pct(1 - poissonCDF(2, λ)), 5, 95);
  out.over35 = out.over3_5 ?? clamp(pct(1 - poissonCDF(3, λ)), 5, 95);
  out.over45 = out.over4_5 ?? clamp(pct(1 - poissonCDF(4, λ)), 5, 95);

  return out;
}

/* ── Red Card Probabilities (Stage 4.3) ──────────────────────────────────── */
// P(roja en partido) usando Poisson sobre la tasa historica de rojas.
// totalRedsAvg suele ser 0.1-0.3 (1 cada 3-10 partidos), asi que
// Poisson(λ_red) es suficiente — no necesitamos overdispersion.

export function calculateRedCardProbabilities(avgTotal) {
  const λ = avgTotal > 0 ? avgTotal : 0.2;  // fallback ~1 cada 5 partidos
  return {
    _mean: +λ.toFixed(2),
    anyRed:    clamp(pct(1 - poissonPMF(0, λ)), 5, 95),  // ≥1 roja
    over1_5:   clamp(pct(1 - poissonCDF(1, λ)), 5, 95),  // ≥2 rojas
  };
}

export function calculatePerTeamRedCardProbabilities(homeAvg, awayAvg) {
  const lH = homeAvg > 0 ? homeAvg : 0.1;
  const lA = awayAvg > 0 ? awayAvg : 0.1;
  return {
    home: {
      anyRed: clamp(pct(1 - poissonPMF(0, lH)), 5, 95),
    },
    away: {
      anyRed: clamp(pct(1 - poissonPMF(0, lA)), 5, 95),
    },
  };
}

/* ── Offside Probabilities (Stage 4.3) ───────────────────────────────────── */
// Offsides totales por partido — distribucion Poisson con overdispersion baja.
// Media tipica liga moderna: 4-6 offsides. Casas de apuestas ofrecen lineas
// 2.5, 3.5, 4.5, 5.5 — calculamos un rango amplio.

export function calculateOffsideProbabilities(avgTotal, perMatchValues) {
  const λ = avgTotal > 0 ? avgTotal : 4.5;
  const od = computeOverdispersion(perMatchValues);
  const lines = adaptiveLines(λ, 0, true).filter(k => k >= 0.5);
  const out = { _lines: lines, _mean: +λ.toFixed(2), _overdispersion: +od.toFixed(2) };

  for (const k of lines) {
    const kFloor = Math.floor(k);
    const overProb = od > 1.05
      ? overSurvival(kFloor, λ, od)
      : (1 - poissonCDF(kFloor, λ));
    const underProb = 1 - overProb;
    out[`over${String(k).replace('.', '_')}`]  = clamp(Math.round(overProb  * 100), 5, 95);
    out[`under${String(k).replace('.', '_')}`] = clamp(Math.round(underProb * 100), 5, 95);
  }
  return out;
}

export function calculatePerTeamOffsideProbabilities(homeMean, awayMean, perMatchHome, perMatchAway) {
  const buildSide = (mean, perMatch) => {
    const λ = mean > 0 ? mean : 2.2;
    const od = computeOverdispersion(perMatch);
    const lines = adaptiveLines(λ, 0, true).filter(k => k >= 0.5);
    const out = { _lines: lines, _mean: +λ.toFixed(2) };
    for (const k of lines) {
      const kFloor = Math.floor(k);
      const overProb = od > 1.05 ? overSurvival(kFloor, λ, od) : (1 - poissonCDF(kFloor, λ));
      const underProb = 1 - overProb;
      out[`over${String(k).replace('.', '_')}`]  = clamp(Math.round(overProb  * 100), 5, 95);
      out[`under${String(k).replace('.', '_')}`] = clamp(Math.round(underProb * 100), 5, 95);
    }
    return out;
  };
  return { home: buildSide(homeMean, perMatchHome), away: buildSide(awayMean, perMatchAway) };
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

  // Builder generico — emite over_K_5 y under_K_5 para todas las lineas
  // adaptativas alrededor de λ. Filter lower-bound permite empezar mas alto
  // (ej cards desde 0.5, corners desde 0.5, goals desde 0.5).
  function buildOverUnder(mean, fallback, useNegBin, od, minLine = 0.5) {
    const λ = mean > 0 ? mean : fallback;
    const lines = adaptiveLines(λ, 0, true).filter(k => k >= minLine);
    const out = { _lines: lines, _mean: +λ.toFixed(2) };
    for (const k of lines) {
      const kFloor = Math.floor(k);
      const overProb  = useNegBin && od > 1.05
        ? overSurvival(kFloor, λ, od)
        : (1 - poissonCDF(kFloor, λ));
      const underProb = 1 - overProb;
      const keyOver  = `over${String(k).replace('.', '_')}`;
      const keyUnder = `under${String(k).replace('.', '_')}`;
      out[keyOver]  = clamp(Math.round(overProb  * 100), 5, 95);
      out[keyUnder] = clamp(Math.round(underProb * 100), 5, 95);
    }
    return out;
  }

  function cornerOverProbs(mean, od) {
    const out = buildOverUnder(mean, 5.2, true, od, 0.5);
    // Legacy aliases
    out.over05 = out.over0_5; out.over15 = out.over1_5; out.over25 = out.over2_5;
    out.over35 = out.over3_5; out.over45 = out.over4_5; out.over55 = out.over5_5;
    return out;
  }

  function cardOverProbs(mean) {
    const out = buildOverUnder(mean, 1.9, false, 1, 0.5);
    // Legacy aliases
    out.over05 = out.over0_5; out.over15 = out.over1_5;
    out.over25 = out.over2_5; out.over35 = out.over3_5;
    return out;
  }

  function goalOverProbs(mean) {
    const out = buildOverUnder(mean, 1.2, false, 1, 0.5);
    // Legacy aliases
    out.over05 = out.over0_5; out.over15 = out.over1_5; out.over25 = out.over2_5;
    return out;
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
 *  rondeados a .5 alrededor de la media esperada. Por defecto genera 5 lineas
 *  (±2 desde el centro). Cuando se llama con `wide=true` genera un rango muy
 *  amplio (de 1.5 hasta media*2.5) para cubrir TODO el espectro de lineas
 *  posibles del bookmaker — el filtro real lo aplica combinada al verificar
 *  si existe cuota en la opcion. */
function adaptiveLines(mean, count = 5, wide = false) {
  if (!Number.isFinite(mean) || mean <= 0) return [];
  if (wide) {
    // Rango amplio: desde 0.5 (o 1.5 para counts grandes) hasta mean*2.5.
    // Genera todas las lineas .5 enteras intermedias.
    const start = Math.max(0.5, Math.floor(mean * 0.3) + 0.5);
    const end   = Math.max(start + 1, Math.ceil(mean * 2.5) - 0.5);
    const lines = [];
    for (let k = start; k <= end; k += 1) lines.push(+k.toFixed(1));
    return lines;
  }
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
/* ── Round classification (Stage 4.1) ─────────────────────────────────────── */
/**
 * Clasifica el round string de API-Football en tipo de partido y devuelve
 * un multiplicador para lambdas + cards. Heuristico empirico — refinar
 * cuando build-calibration tenga suficiente sample por round_type.
 *
 * Tipos detectados (case-insensitive):
 *   - 'final'           — Final de copa/torneo. Partidos cerrados.
 *   - 'semi'            — Semifinal. Cierra menos que final, pero tense.
 *   - 'quarter'         — Cuartos. Equipos top, tactica defensiva.
 *   - 'qualifying'      — Rondas previas. Asimetrico (David vs Goliath).
 *   - 'group_decisive'  — Ultima jornada de grupos. Variable.
 *   - 'leg_2nd'         — Segunda mano de eliminatoria. Depende agregado.
 *   - 'regular'         — Resto (jornada N, regular season).
 */
export function classifyRound(roundString) {
  if (!roundString || typeof roundString !== 'string') return 'regular';
  const s = roundString.toLowerCase();

  // Orden importante: matches mas especificos primero
  if (/2nd leg|second leg|segunda mano|2ª mano|ida y vuelta.*vuelta/i.test(s)) return 'leg_2nd';
  if (/1st leg|first leg|primera mano|1ª mano/i.test(s)) return 'leg_1st';

  if (/\bfinal\b/.test(s) && !/semi|quarter|1\/8|cuart|octav/.test(s)) return 'final';
  if (/semi.?final|semifinal/.test(s)) return 'semi';
  if (/quarter.?final|quarterfinal|cuartos|1\/4/.test(s)) return 'quarter';
  if (/1\/8|round of 16|octavos/.test(s)) return 'round_of_16';
  if (/1\/16|round of 32|dieciseisavos/.test(s)) return 'round_of_32';

  if (/qualifying|qual\.|preliminary|previa/.test(s)) return 'qualifying';

  // Grupo decisivo: ultima jornada de fase de grupos (suele ser jornada 6
  // en Champions/Europa, jornada 3 en grupos de copas continentales).
  if (/group.*6|matchday 6|jornada 6|matchday-6/i.test(s)) return 'group_decisive';
  if (/group/i.test(s)) return 'group';

  return 'regular';
}

/**
 * Multiplicador heurístico para lambdas según tipo de round.
 *
 * REGLA: en partidos de alta importancia (final/semi/leg de eliminatoria)
 * los equipos juegan CONSERVADOR y APRETADO. Eso significa:
 *   - Menos goles esperados (λ_goles baja).
 *   - MENOS córners también — equipos no se lanzan al ataque, juegan al medio,
 *     buscan la pelota detenida y la falta táctica antes que la jugada por
 *     banda que termina en córner.
 *   - MÁS tarjetas — la tensión sube, faltas tácticas, reclamos al árbitro,
 *     tiempo perdido, todo eso son amarillas.
 *
 * NO confundir con derby de liga regular — esos tienen alta intensidad PERO
 * sin la presión de eliminación, así que los equipos siguen jugando abierto.
 * Ese boost se aplica aparte en applyImportanceAdjustment cuando isDerby+regular.
 *
 * Returns { lambdaMul, cornerMul, cardMul } con factor multiplicativo.
 */
function roundLambdaFactor(roundType) {
  const map = {
    // Eliminatorias: λ↓ corners↓ cards↑ (lógica conservadora explícita)
    final:           { lambdaMul: 0.88, cornerMul: 0.90, cardMul: 1.20 },
    semi:            { lambdaMul: 0.92, cornerMul: 0.93, cardMul: 1.13 },
    quarter:         { lambdaMul: 0.95, cornerMul: 0.95, cardMul: 1.08 },
    round_of_16:     { lambdaMul: 0.97, cornerMul: 0.97, cardMul: 1.04 },
    round_of_32:     { lambdaMul: 0.99, cornerMul: 0.99, cardMul: 1.02 },
    // Leg 1: tactico extremo, evitar gol visitante. Leg 2: depende agregado
    // (eso lo ajusta findAggregateAdjustment aparte).
    leg_1st:         { lambdaMul: 0.92, cornerMul: 0.92, cardMul: 1.05 },
    leg_2nd:         { lambdaMul: 0.98, cornerMul: 0.97, cardMul: 1.08 },
    // Group decisive: todo o nada, abierto. Group regular: neutro.
    group_decisive:  { lambdaMul: 1.03, cornerMul: 1.02, cardMul: 1.05 },
    group:           { lambdaMul: 1.00, cornerMul: 1.00, cardMul: 1.00 },
    // Qualifying: David vs Goliath, mas goles asimétricos.
    qualifying:      { lambdaMul: 1.05, cornerMul: 1.02, cardMul: 0.95 },
    regular:         { lambdaMul: 1.00, cornerMul: 1.00, cardMul: 1.00 },
  };
  return map[roundType] || map.regular;
}

/* ── Derbies / clásicos hardcodeados (Stage 5 invertido) ─────────────────── */
// Pares de equipos rivales en liga regular. Solo aplican cuando round=regular
// (en eliminatoria entre rivales, el factor de round ya domina y es opuesto).
//
// Formato: { leagueId: [[teamIdA, teamIdB], ...] }
// IDs de API-Football. Verificar antes de agregar otros derbies.
const DERBIES = {
  // La Liga (140) — El Clásico, derby de Madrid, derby de Sevilla, derby vasco
  140: [
    [541, 529],  // Real Madrid vs Barcelona
    [541, 530],  // Real Madrid vs Atlético
    [536, 559],  // Sevilla vs Real Betis
    [531, 548],  // Athletic Club vs Real Sociedad
    [532, 533],  // Valencia vs Villarreal
  ],
  // Premier League (39) — North London, Manchester, Merseyside, North-West
  39: [
    [42,  47],   // Arsenal vs Tottenham
    [33,  50],   // Man United vs Man City
    [40,  45],   // Liverpool vs Everton
    [33,  40],   // Man United vs Liverpool
    [49,  47],   // Chelsea vs Tottenham
    [49,  42],   // Chelsea vs Arsenal
  ],
  // Bundesliga (78) — Klassiker, Revierderby, Nordderby
  78: [
    [157, 165],  // Bayern vs Dortmund
    [165, 169],  // Dortmund vs Schalke
    [167, 173],  // Hamburg vs Werder Bremen (cuando ambos en Bundesliga)
  ],
  // Serie A (135) — Derby di Milano, della Mole, della Capitale, di Genova
  135: [
    [505, 489],  // Inter vs AC Milan
    [496, 487],  // Juventus vs Torino
    [497, 487],  // AS Roma vs Lazio
    [498, 488],  // Genoa vs Sampdoria
    [496, 505],  // Juventus vs Inter
    [489, 496],  // Milan vs Juventus
  ],
  // Ligue 1 (61) — Le Classique, Olympico, Derby du Nord
  61: [
    [85,  81],   // PSG vs Marseille
    [80,  81],   // Lyon vs Marseille
    [79,  81],   // Lille vs Marseille
  ],
  // Brasileirão (71) — clásicos por estado (top 4 Río + 4 SP + Mineiro)
  71: [
    [127, 124],  // Flamengo vs Fluminense
    [126, 133],  // Botafogo vs Vasco
    [134, 119],  // Palmeiras vs Corinthians
    [120, 126],  // São Paulo vs Botafogo
    [120, 134],  // São Paulo vs Palmeiras
    [120, 119],  // São Paulo vs Corinthians
    [121, 1062], // Atlético-MG vs Cruzeiro
  ],
  // Argentina (128) — Superclásico, Avellaneda, Rosarino, La Plata
  128: [
    [435, 451],  // Boca vs River
    [442, 460],  // Racing vs Independiente
    [434, 478],  // Rosario Central vs Newell's
    [474, 462],  // Estudiantes vs Gimnasia
    [445, 453],  // San Lorenzo vs Huracán
  ],
  // Liga MX (262) — Clásico Nacional, Capitalino, Tapatío, Regiomontano
  262: [
    [2287, 2289], // América vs Chivas
    [2287, 2282], // América vs Cruz Azul
    [2287, 2294], // América vs Pumas
    [2289, 2284], // Chivas vs Atlas
    [2295, 2283], // Monterrey vs Tigres
  ],
  // Eredivisie (88) — De Klassieker
  88: [
    [194, 197],  // Ajax vs Feyenoord
    [194, 195],  // Ajax vs PSV
    [195, 197],  // PSV vs Feyenoord
  ],
  // Liga BetPlay Colombia (239) — Clásicos cafeteros
  239: [
    [1466, 1450], // Millonarios vs Santa Fe
    [1465, 1462], // Atlético Nacional vs Once Caldas
    [1465, 1481], // Atlético Nacional vs Independiente Medellín
  ],
  // Primeira Liga Portugal (94) — O Clássico
  94: [
    [212, 228],  // Benfica vs Porto
    [212, 211],  // Benfica vs Sporting
    [228, 211],  // Porto vs Sporting
  ],
};

function isDerby(leagueId, homeId, awayId) {
  const pairs = DERBIES[leagueId];
  if (!Array.isArray(pairs)) return false;
  const h = Number(homeId), a = Number(awayId);
  return pairs.some(([x, y]) => (x === h && y === a) || (x === a && y === h));
}

/* ── Match importance heuristic (Stage 5) ────────────────────────────────── */
// Total de matchdays por liga regular (sin contar copas). API-Football no
// expone "matches_remaining" directo, asi que hardcodeamos las temporadas
// regulares. Para ligas que no esten aqui, no aplicamos importance.
const LEAGUE_TOTAL_MATCHDAYS = {
  39:  38,  // Premier League
  40:  46,  // Championship
  140: 38,  // La Liga
  141: 42,  // La Liga 2
  78:  34,  // Bundesliga
  79:  34,  // 2. Bundesliga
  135: 38,  // Serie A
  136: 38,  // Serie B
  61:  34,  // Ligue 1
  62:  38,  // Ligue 2
  203: 38,  // Süper Lig
  88:  34,  // Eredivisie
  94:  34,  // Primeira Liga
  144: 34,  // Jupiler Pro
  207: 36,  // Super League Switzerland
  218: 32,  // Bundesliga Austria
  103: 30,  // Eliteserien
  113: 30,  // Allsvenskan
  119: 32,  // Superliga DK
  106: 34,  // Ekstraklasa
  235: 30,  // Premier League Russia
  333: 30,  // Premier League Ukraine
  98:  34,  // J1 League
  292: 38,  // K-League 1
  169: 30,  // China Super League
  253: 34,  // MLS
  188: 27,  // A-League
  71:  38,  // Brasileirao A
  128: 30,  // Argentina Liga Profesional
  262: 17,  // Liga MX
  239: 20,  // Liga BetPlay Colombia (apertura/clausura = 20 jornadas)
  265: 30,  // Chile Primera
  268: 15,  // Uruguay Primera (apertura = 15)
  281: 19,  // Peru Liga 1
  242: 15,  // Ecuador Serie A
  250: 22,  // Paraguay
  307: 34,  // Saudi Pro League
};

/**
 * Parsea "Regular Season - 33" → 33. Devuelve null si no es regular season.
 */
function parseRegularSeasonMatchday(roundString) {
  if (!roundString) return null;
  const m = roundString.match(/regular season\s*[-—–]\s*(\d+)/i);
  if (m) return parseInt(m[1], 10);
  const m2 = roundString.match(/jornada\s*(\d+)/i) || roundString.match(/matchday\s*(\d+)/i);
  return m2 ? parseInt(m2[1], 10) : null;
}

/**
 * Heurístico de "importancia del partido" (Stage 5 invertido).
 *
 * Devuelve multiplicadores SEPARADOS para λ_goles, corners y cards, en lugar
 * de aplicar al lambda directamente. El caller los combina con los del round
 * (roundLambdaFactor). Eso permite que ambos efectos coexistan correctamente:
 *
 *   - Final + equipo en lucha CL: round baja goles 12%, importance los sube 6%.
 *     Resultado neto: 0.88 * 1.06 = 0.93 (sigue siendo conservador).
 *
 * LÓGICA INVERTIDA EXPLÍCITA POR roundType:
 *   - Eliminatorias (final/semi/quarter/round_of_16/leg_1st/leg_2nd):
 *     NO aplicamos boost ofensivo del importance. El factor de round YA
 *     captura el comportamiento conservador. Lo único que sí aplica el
 *     importance es desmotivación de equipos ya eliminados (no relevante en
 *     eliminatorias porque si están ahí, juegan a ganar).
 *
 *   - Derby de liga regular (isDerby + roundType === 'regular'):
 *     Intensidad sin presión de eliminación → cards SUBEN fuerte (+20%),
 *     corners suben leve (+5%), goles suben leve (+5%). Esto es ADICIONAL al
 *     importance regular por posición.
 *
 *   - Liga regular fase final (≥85% jornadas):
 *     Aplica lógica clásica de motivación por puesto (lucha CL/descenso sube
 *     λ; midtable/descendido baja λ). Corners y cards heredan el mismo factor
 *     atenuado (×0.6 del lambda) porque el efecto en intensidad existe pero
 *     es menor que en goles.
 *
 * Conservador: si falta matchday/totalMd, devuelve neutros (1.0) salvo derby.
 */
function applyImportanceAdjustment(leagueId, leagueRound, homePosition, awayPosition, roundType, homeId, awayId) {
  const neutral = {
    lambdaHomeMul: 1, lambdaAwayMul: 1, cornerMul: 1, cardMul: 1, importance: null,
  };

  // 1. Derby de liga regular — único caso que sube cards y corners aparte
  //    del flujo de "fase final de temporada". Se calcula primero porque
  //    aplica independiente del progreso de temporada.
  const derby = roundType === 'regular' && isDerby(leagueId, homeId, awayId);
  const derbyMul = derby
    ? { lambdaHomeMul: 1.05, lambdaAwayMul: 1.05, cornerMul: 1.05, cardMul: 1.20 }
    : { lambdaHomeMul: 1.00, lambdaAwayMul: 1.00, cornerMul: 1.00, cardMul: 1.00 };

  // 2. En eliminatorias NO aplicamos lógica de "lucha por puesto" — el
  //    factor de round ya captura el comportamiento. Solo derby boost si
  //    aplica (raro en eliminatoria entre rivales, pero posible).
  if (roundType !== 'regular') {
    if (!derby) return neutral;
    return {
      ...derbyMul,
      importance: { stage: 'knockout', derby },
    };
  }

  // 3. Liga regular: aplicar lógica de motivación por posición SOLO en
  //    fase final de temporada. Combinar con derby boost si aplica.
  const totalMd = LEAGUE_TOTAL_MATCHDAYS[leagueId];
  const currentMd = parseRegularSeasonMatchday(leagueRound);
  if (!totalMd || !currentMd) {
    return derby
      ? { ...derbyMul, importance: { stage: 'unknown', derby } }
      : neutral;
  }

  const seasonProgress = currentMd / totalMd;
  const isLateSeason = seasonProgress >= 0.85;
  const isMidSeason  = seasonProgress >= 0.30 && seasonProgress < 0.85;

  if (!isLateSeason) {
    return derby
      ? { ...derbyMul, importance: { stage: isMidSeason ? 'mid' : 'early', derby } }
      : { ...neutral, importance: { stage: isMidSeason ? 'mid' : 'early', derby: false } };
  }

  // Categorías por posición (asumiendo liga de ~20 equipos)
  function classify(pos) {
    if (!pos) return 'unknown';
    if (pos <= 2) return 'champion_race';
    if (pos <= 4) return 'cl_race';
    if (pos <= 7) return 'europa_race';
    if (pos >= 18) return 'relegation';
    if (pos >= 15) return 'relegation_fight';
    return 'midtable';
  }

  function lambdaMulFor(category) {
    switch (category) {
      case 'champion_race':    return 1.05;
      case 'cl_race':          return 1.06;
      case 'europa_race':      return 1.04;
      case 'relegation_fight': return 1.05;
      case 'relegation':       return 0.92;
      case 'midtable':         return 0.93;
      default:                 return 1.0;
    }
  }

  const homeCat = classify(homePosition);
  const awayCat = classify(awayPosition);
  const homeLambdaMul = lambdaMulFor(homeCat);
  const awayLambdaMul = lambdaMulFor(awayCat);

  // Corners y cards heredan efecto atenuado (×0.6 de la desviación del lambda)
  // — intensidad emocional sí afecta corners/cards pero menos que goles.
  const avgLambdaDev = ((homeLambdaMul + awayLambdaMul) / 2) - 1;
  const importanceCornerMul = 1 + avgLambdaDev * 0.6;
  const importanceCardMul   = 1 + avgLambdaDev * 0.6;

  // Combinar con derby (si aplica) multiplicando
  return {
    lambdaHomeMul: homeLambdaMul * derbyMul.lambdaHomeMul,
    lambdaAwayMul: awayLambdaMul * derbyMul.lambdaAwayMul,
    cornerMul:     importanceCornerMul * derbyMul.cornerMul,
    cardMul:       importanceCardMul   * derbyMul.cardMul,
    importance: {
      stage: 'late',
      progress: +seasonProgress.toFixed(2),
      home: { category: homeCat, mul: homeLambdaMul },
      away: { category: awayCat, mul: awayLambdaMul },
      derby,
    },
  };
}

/* ── Aggregate score adjustment (Stage 4.2 — ida/vuelta) ─────────────────── */
/**
 * Para 2da mano de eliminatoria, ajusta λ según el agregado del 1er leg.
 * Equipo que va perdiendo el global → λ_attack +20% (presion ofensiva).
 * Equipo que va ganando holgado → λ_attack -15% (gestiona ventaja).
 *
 * @param {Array} h2h    — head-to-head matches (incluye el 1st leg si existe)
 * @param {number} leagueId
 * @param {string} currentDate — ISO date del partido actual
 * @param {number} homeId, awayId — del partido 2nd leg
 * @returns {{ aggDiff: number, adjustment: {lambdaHomeMul, lambdaAwayMul, cardMul} } | null}
 */
function findAggregateAdjustment(h2h, leagueId, currentDate, homeId, awayId) {
  if (!Array.isArray(h2h) || h2h.length === 0) return null;

  // Buscar el partido mas reciente entre los 2 equipos, misma liga,
  // terminado, ANTES de la fecha del partido actual.
  const finished = ['FT', 'AET', 'PEN'];
  const currentTs = new Date(currentDate).getTime();
  const candidates = h2h
    .filter(m => m.league?.id === leagueId)
    .filter(m => finished.includes(m.fixture?.status?.short))
    .filter(m => new Date(m.fixture?.date).getTime() < currentTs)
    .sort((a, b) => new Date(b.fixture?.date).getTime() - new Date(a.fixture?.date).getTime());

  const firstLeg = candidates[0];
  if (!firstLeg) return null;

  // En el 1st leg, el equipo away actual era home. Si no matchea, no es leg
  // legítimo (puede ser un partido de copa de otra temporada).
  if (firstLeg.teams?.home?.id !== awayId || firstLeg.teams?.away?.id !== homeId) {
    return null;
  }

  // Usar score.fulltime (90 min) — los agregados de copas se calculan a 90min
  // EXCEPTO si la UEFA contó AET para la regla de away goals; ya no aplica
  // desde 2021 en UEFA, pero por seguridad usamos fulltime que es estandar.
  const flHome = firstLeg.score?.fulltime?.home ?? firstLeg.goals?.home ?? 0;
  const flAway = firstLeg.score?.fulltime?.away ?? firstLeg.goals?.away ?? 0;

  // currentHome era 1st leg away → su agregado del 1er leg = flAway
  // currentAway era 1st leg home → su agregado del 1er leg = flHome
  // Diferencia favorable a currentHome:
  const aggDiff = flAway - flHome;

  // Mapeo de aggDiff → ajustes
  let lambdaHomeMul = 1.0, lambdaAwayMul = 1.0, cardMul = 1.05;
  if (aggDiff >= 3) {
    lambdaHomeMul = 0.82; lambdaAwayMul = 1.18; cardMul = 1.05;
  } else if (aggDiff === 2) {
    lambdaHomeMul = 0.88; lambdaAwayMul = 1.12; cardMul = 1.05;
  } else if (aggDiff === 1) {
    lambdaHomeMul = 0.94; lambdaAwayMul = 1.06; cardMul = 1.05;
  } else if (aggDiff === 0) {
    // Empate global — partido tense, leve cierre defensivo
    lambdaHomeMul = 0.96; lambdaAwayMul = 0.96; cardMul = 1.10;
  } else if (aggDiff === -1) {
    lambdaHomeMul = 1.08; lambdaAwayMul = 0.94; cardMul = 1.05;
  } else if (aggDiff === -2) {
    lambdaHomeMul = 1.15; lambdaAwayMul = 0.88; cardMul = 1.05;
  } else { // aggDiff <= -3
    lambdaHomeMul = 1.22; lambdaAwayMul = 0.82; cardMul = 1.05;
  }

  return {
    aggDiff,
    firstLegScore: { home: flHome, away: flAway },
    adjustment: { lambdaHomeMul, lambdaAwayMul, cardMul },
  };
}

/* ── Injury adjustment (Stage 3.2) ───────────────────────────────────────── */
/**
 * Reduce lambdaHome/Away segun lesiones de jugadores top en el XI titular.
 *
 * Logica:
 *   - Cruza filteredInjuries (jugadores del XI titular lesionados) con
 *     playerHighlights.scorers (top scorers histortcos del equipo).
 *   - Si un goleador esta lesionado, restamos su contribucion media a la λ
 *     del equipo. El suplente cubre ~50% (heuristico — sin data del rendimiento
 *     del suplente especifico, asumimos que el reserva produce la mitad).
 *
 * Restriccion:
 *   - Sample size minimo 5 partidos (sino el promedio es ruido).
 *   - Contribucion minima 0.3 goles/partido (jugadores irrelevantes no
 *     mueven la aguja).
 *   - Clamp a max 0.5*λ — un equipo nunca queda con λ < 50% por lesiones,
 *     hay otros 10 jugadores que pueden generar peligro.
 */
function applyInjuryAdjustment(lambdaHome, lambdaAway, injuries, playerHighlights, homeId, awayId) {
  if (!Array.isArray(injuries) || injuries.length === 0) {
    return { lambdaHome, lambdaAway };
  }
  const scorers = (playerHighlights?.scorers || []).concat(playerHighlights?.shooters || []);
  if (scorers.length === 0) return { lambdaHome, lambdaAway };

  let homeReduction = 0;
  let awayReduction = 0;

  for (const inj of injuries) {
    const pid = inj.player?.id;
    const tid = inj.team?.id;
    if (!pid || !tid) continue;

    const scorer = scorers.find(s => s.id === pid);
    if (!scorer) continue;

    const sample = scorer.goals || [];
    if (sample.length < 5) continue;

    const avg = sample.reduce((a, b) => a + b, 0) / sample.length;
    if (avg < 0.3) continue;

    // Suplente cubre ~50% — el resto se pierde del λ
    const reduction = avg * 0.5;

    if (tid === homeId) homeReduction += reduction;
    else if (tid === awayId) awayReduction += reduction;
  }

  return {
    lambdaHome: Math.max(lambdaHome * 0.5, lambdaHome - homeReduction),
    lambdaAway: Math.max(lambdaAway * 0.5, lambdaAway - awayReduction),
  };
}

export function computeAllProbabilities(analysis) {
  const {
    h2h, homeLastFive, awayLastFive, homeId, awayId,
    cornerCardData, goalTimingData,
    homePosition, awayPosition, leagueId,
    refereeFactor,
    filteredInjuries, playerHighlights,
    leagueRound,
  } = analysis;

  // ── 1. Expected goals — foundation for all outcome predictions ──
  const baseLambdas = computeExpectedGoals(
    homeLastFive, awayLastFive, h2h,
    homeId, awayId,
    homePosition, awayPosition,
    leagueId
  );

  // Stage 3.2: ajuste por lesiones de scorers/shooters del XI titular
  const injuryAdjusted = applyInjuryAdjustment(
    baseLambdas.lambdaHome,
    baseLambdas.lambdaAway,
    filteredInjuries,
    playerHighlights,
    homeId, awayId,
  );

  // Stage 4.1: ajuste por tipo de round (final/semi/qualifying/etc).
  // Lógica INVERTIDA en eliminatorias: goles BAJAN, córners BAJAN, cards SUBEN.
  // Ver roundLambdaFactor para los multiplicadores explícitos por roundType.
  const roundType = classifyRound(leagueRound);
  const roundFactor = roundLambdaFactor(roundType);
  let homeAttackMul = roundFactor.lambdaMul;
  let awayAttackMul = roundFactor.lambdaMul;
  let cornerMul = roundFactor.cornerMul;
  let cardMul = roundFactor.cardMul;
  let aggregateInfo = null;

  // Stage 4.2: si es 2nd leg, buscar el agregado del 1st leg en h2h y ajustar
  // ASIMÉTRICAMENTE. Los multiplicadores acumulan con los del roundType.
  if (roundType === 'leg_2nd' && analysis.kickoff) {
    aggregateInfo = findAggregateAdjustment(h2h, leagueId, analysis.kickoff, homeId, awayId);
    if (aggregateInfo) {
      const adj = aggregateInfo.adjustment;
      homeAttackMul *= adj.lambdaHomeMul;
      awayAttackMul *= adj.lambdaAwayMul;
      cardMul *= adj.cardMul;
    }
  }

  // Stage 5 (invertido): importance ahora devuelve multiplicadores SEPARADOS
  // y NO aplica al lambda directamente. En eliminatorias devuelve neutros
  // (el roundFactor ya manda). En liga regular aplica boost de derby y/o
  // motivación por posición.
  const importanceAdj = applyImportanceAdjustment(
    leagueId, leagueRound, homePosition, awayPosition,
    roundType, homeId, awayId,
  );
  homeAttackMul *= importanceAdj.lambdaHomeMul;
  awayAttackMul *= importanceAdj.lambdaAwayMul;
  cornerMul     *= importanceAdj.cornerMul;
  cardMul       *= importanceAdj.cardMul;
  const importanceInfo = importanceAdj.importance;

  const lambdaHome = Math.max(0.3, Math.min(5.0, injuryAdjusted.lambdaHome * homeAttackMul));
  const lambdaAway = Math.max(0.3, Math.min(5.0, injuryAdjusted.lambdaAway * awayAttackMul));

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

  // cornerMul aplica el ajuste de roundType + importance (Stage 5 invertido):
  // eliminatorias bajan corners, derby de liga regular los sube leve.
  const baseCornerAvg = ccd.hasRealData ? (ccd.totalCornersAvg || 10.4) : 10.4;
  const cornerAvg = Math.max(2, Math.min(20, baseCornerAvg * cornerMul));
  const cardAvg   = ccd.hasRealData ? (ccd.totalCardsAvg   || 3.8)  : 3.8;

  const corners = calculateCornerProbabilities(cornerAvg, allCornersPerMatch);
  const refFactor = (typeof refereeFactor === 'number' && refereeFactor > 0) ? refereeFactor : 1;
  const allCardsPerMatch = [
    ...(ccd.homeCardsPerMatch || []),
    ...(ccd.awayCardsPerMatch || []),
  ];
  // Stage 4.1: combina refereeFactor con roundCardMul (finales/semis tienen
  // mas tarjetas por la tension; qualifying menos). El producto se clampea
  // implicitamente en calculateCardProbabilities (lambda min 0.3 max 5).
  const cards = calculateCardProbabilities(cardAvg, refFactor * cardMul, allCardsPerMatch);

  // Per-team: aplicamos los multiplicadores (cornerMul / cardMul*refFactor)
  // al average por equipo cuando hay data real. El fallback cornerAvg/2 ya
  // tiene cornerMul aplicado (no doblar). Para cards el fallback se calcula
  // desde cardAvg crudo, así que sí necesita cardMul*refFactor.
  const cardFallbackHalf = (cardAvg / 2) * cardMul * refFactor;
  const homeCornerAvg = ccd.hasRealData
    ? (ccd.homeCornersAvg ? ccd.homeCornersAvg * cornerMul : cornerAvg / 2)
    : cornerAvg / 2;
  const awayCornerAvg = ccd.hasRealData
    ? (ccd.awayCornersAvg ? ccd.awayCornersAvg * cornerMul : cornerAvg / 2)
    : cornerAvg / 2;
  const homeCardAvg   = ccd.hasRealData
    ? (ccd.homeYellowsAvg ? ccd.homeYellowsAvg * cardMul * refFactor : cardFallbackHalf)
    : cardFallbackHalf;
  const awayCardAvg   = ccd.hasRealData
    ? (ccd.awayYellowsAvg ? ccd.awayYellowsAvg * cardMul * refFactor : cardFallbackHalf)
    : cardFallbackHalf;

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

  // Stage 4.3: Nuevos mercados — roja, penalti (heurístico), offside
  const redCards = calculateRedCardProbabilities(ccd.totalRedsAvg || 0);
  const perTeamRedCards = calculatePerTeamRedCardProbabilities(
    ccd.homeRedsAvg || 0,
    ccd.awayRedsAvg || 0,
  );
  // Offside solo si tenemos data real (algunas ligas menores no reportan)
  const offsides = (ccd.totalOffsidesAvg > 0)
    ? calculateOffsideProbabilities(
        ccd.totalOffsidesAvg,
        [...(ccd.homeOffsidesPerMatch || []), ...(ccd.awayOffsidesPerMatch || [])],
      )
    : null;
  const perTeamOffsides = (ccd.totalOffsidesAvg > 0)
    ? calculatePerTeamOffsideProbabilities(
        ccd.homeOffsidesAvg || 0,
        ccd.awayOffsidesAvg || 0,
        ccd.homeOffsidesPerMatch,
        ccd.awayOffsidesPerMatch,
      )
    : null;

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
    // Stage 4.3 — mercados nuevos
    redCards,              // { anyRed, over1_5 }
    perTeamRedCards,       // { home:{anyRed}, away:{anyRed} }
    offsides,              // { _lines, _mean, over2_5, under2_5, ... } o null
    perTeamOffsides,       // { home, away } o null
    // Round info (Stage 4.1) — útil para debug en /ferney
    roundType,
    // Aggregate info (Stage 4.2) — solo presente si es 2nd leg con 1st leg detectado
    aggregateInfo,
    // Importance info (Stage 5) — solo presente si tenemos matchday + position
    importanceInfo,
  };
}
