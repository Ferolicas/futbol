'use strict';

const EPSILON = 1e-12;
const DEFAULT_VALIDATION_MIN_N = 30;
const DEFAULT_MAX_CALIBRATION_GAP = 0.05;
const DEFAULT_CALIBRATION_PRIOR_N = 100;
const DEFAULT_MIN_EXPECTED_VALUE = 0.05;

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampProbability(value) {
  const probability = finiteNumber(value);
  if (probability == null) return null;
  return Math.max(0, Math.min(1, probability));
}

/**
 * Normaliza una distribución sin esconder masa perdida. Los valores negativos,
 * NaN e infinitos son un error de contrato; una distribución vacía no puede
 * convertirse artificialmente en uniforme.
 */
function normalizeDistribution(values, tolerance = 1e-9) {
  const isArray = Array.isArray(values);
  const entries = isArray ? values.map((value, index) => [index, value]) : Object.entries(values || {});
  if (!entries.length) throw new Error('prediction_distribution_empty');
  let total = 0;
  const parsed = entries.map(([key, value]) => {
    const probability = finiteNumber(value);
    if (probability == null || probability < 0) throw new Error(`prediction_distribution_invalid:${key}`);
    total += probability;
    return [key, probability];
  });
  if (!(total > tolerance)) throw new Error('prediction_distribution_zero_mass');
  const normalized = parsed.map(([key, value]) => [key, value / total]);
  const normalizedTotal = normalized.reduce((sum, [, value]) => sum + value, 0);
  // Absorbe exclusivamente el error de coma flotante en el último elemento.
  normalized[normalized.length - 1][1] += 1 - normalizedTotal;
  if (isArray) return normalized.map(([, value]) => value);
  return Object.fromEntries(normalized);
}

function distributionTotal(values) {
  const entries = Array.isArray(values) ? values : Object.values(values || {});
  return entries.reduce((sum, value) => sum + (finiteNumber(value) || 0), 0);
}

/** Corte estricto: jamás permite que un análisis previo use hechos del kickoff o posteriores. */
function strictPregameCutoff(kickoff, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const kickoffDate = kickoff instanceof Date ? kickoff : new Date(kickoff);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('prediction_now_invalid');
  if (!Number.isFinite(kickoffDate.getTime())) return nowDate;
  return new Date(Math.min(nowDate.getTime(), kickoffDate.getTime() - 1));
}

function impliedProbability(odd) {
  const decimalOdd = finiteNumber(odd);
  return decimalOdd != null && decimalOdd > 1 ? 1 / decimalOdd : null;
}

/** Probabilidades justas relativas de una casa, eliminando el overround. */
function deVigProbabilities(odds) {
  const entries = Array.isArray(odds) ? odds.map((odd, index) => [index, odd]) : Object.entries(odds || {});
  if (entries.length < 2) return null;
  const implied = entries.map(([key, odd]) => [key, impliedProbability(odd)]);
  if (implied.some(([, probability]) => probability == null)) return null;
  const normalized = normalizeDistribution(Object.fromEntries(implied));
  return Array.isArray(odds) ? entries.map(([key]) => normalized[key]) : normalized;
}

/** Retorno esperado por una unidad apostada; el push devuelve la unidad y aporta cero. */
function offeredExpectedValue(probability, odd, pushProbability = 0) {
  const win = clampProbability(probability);
  const push = clampProbability(pushProbability);
  const decimalOdd = finiteNumber(odd);
  if (win == null || push == null || decimalOdd == null || decimalOdd <= 1 || win + push > 1 + EPSILON) return null;
  const loss = Math.max(0, 1 - win - push);
  return win * (decimalOdd - 1) - loss;
}

function validationUncertainty(avgActual, sampleN, z = 1.96) {
  const actual = clampProbability(avgActual);
  const n = finiteNumber(sampleN);
  if (actual == null || n == null || n <= 0) return null;
  return z * Math.sqrt(Math.max(EPSILON, actual * (1 - actual)) / n);
}

/**
 * Un mercado puede publicarse solo cuando la validación temporal de su misma
 * familia y banda respalda la cifra. La muestra es global de la familia, no el
 * número de partidos recientes de un equipo nuevo.
 */
function assessValidation(validation, options = {}) {
  const minN = finiteNumber(options.minN) ?? DEFAULT_VALIDATION_MIN_N;
  const maxGap = finiteNumber(options.maxGap) ?? DEFAULT_MAX_CALIBRATION_GAP;
  if (!validation?.available) return { eligible: false, status: 'unvalidated', n: 0, gap: null, allowedGap: null };
  const n = finiteNumber(validation.n) || 0;
  const avgPred = clampProbability(validation.avgPred);
  const avgActual = clampProbability(validation.avgActual);
  if (n < minN || avgPred == null || avgActual == null) {
    return { eligible: false, status: 'insufficient-validation', n, gap: null, allowedGap: null };
  }
  const gap = Math.abs(avgPred - avgActual);
  // Con muestras pequeñas no fingimos precisión de cinco puntos: aceptamos el
  // mayor entre el objetivo y la incertidumbre estadística medida.
  const uncertainty = validationUncertainty(avgActual, n) || 0;
  const allowedGap = Math.max(maxGap, uncertainty);
  return {
    eligible: gap <= allowedGap + EPSILON,
    status: gap <= allowedGap + EPSILON ? 'calibrated' : 'miscalibrated',
    n,
    gap,
    allowedGap,
    uncertainty,
  };
}

/**
 * Ajuste conservador por familia. La corrección observada entra gradualmente;
 * con poca evidencia la cifra permanece cerca del modelo y, además, el gate
 * de assessValidation impide venderla como recomendación.
 */
function calibrateProbability(probability, validation, options = {}) {
  const raw = clampProbability(probability);
  if (raw == null) return null;
  if (!validation?.available) return raw;
  const n = finiteNumber(validation.n) || 0;
  const avgPred = clampProbability(validation.avgPred);
  const avgActual = clampProbability(validation.avgActual);
  if (!n || avgPred == null || avgActual == null) return raw;
  const priorN = finiteNumber(options.priorN) ?? DEFAULT_CALIBRATION_PRIOR_N;
  const strength = n / (n + Math.max(1, priorN));
  return clampProbability(raw + strength * (avgActual - avgPred));
}

function recommendationDecision(input, options = {}) {
  const probability = clampProbability(input?.probability);
  const odd = finiteNumber(input?.odd);
  const reliability = finiteNumber(input?.reliability);
  const minimumProbability = finiteNumber(options.minimumProbability) ?? 0.70;
  const minimumReliability = finiteNumber(options.minimumReliability) ?? 90;
  const minimumExpectedValue = finiteNumber(options.minimumExpectedValue) ?? DEFAULT_MIN_EXPECTED_VALUE;
  const validation = assessValidation(input?.validation, options.validation);
  const expectedValue = offeredExpectedValue(probability, odd, input?.pushProbability || 0);
  const marketFairProbability = clampProbability(input?.marketFairProbability);
  const marketEdge = probability == null || marketFairProbability == null ? null : probability - marketFairProbability;
  const minimumMarketEdge = finiteNumber(options.minimumMarketEdge) ?? 0;
  const reasons = [];
  if (probability == null || probability + EPSILON < minimumProbability) reasons.push('probability');
  if (reliability == null || reliability + EPSILON < minimumReliability) reasons.push('reliability');
  if (!validation.eligible) reasons.push(validation.status);
  if (odd == null || odd <= 1) reasons.push('odds');
  if (expectedValue == null || expectedValue + EPSILON < minimumExpectedValue) reasons.push('expected-value');
  if (marketFairProbability != null && marketEdge + EPSILON < minimumMarketEdge) reasons.push('market-edge');
  return {
    eligible: reasons.length === 0,
    reasons,
    probability,
    reliability,
    expectedValue,
    marketFairProbability,
    marketEdge,
    validation,
  };
}

module.exports = {
  DEFAULT_VALIDATION_MIN_N,
  DEFAULT_MAX_CALIBRATION_GAP,
  DEFAULT_CALIBRATION_PRIOR_N,
  DEFAULT_MIN_EXPECTED_VALUE,
  finiteNumber,
  clampProbability,
  normalizeDistribution,
  distributionTotal,
  strictPregameCutoff,
  impliedProbability,
  deVigProbabilities,
  offeredExpectedValue,
  validationUncertainty,
  assessValidation,
  calibrateProbability,
  recommendationDecision,
};
