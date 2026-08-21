// Núcleo CommonJS de fiabilidad beta-binomial, compartido por los motores.

function logGamma(x) {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) { y += 1; ser += cof[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function betaContinuedFraction(a, b, x) {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

function regularizedIncompleteBeta(a, b, x) {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b)
    + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? front * betaContinuedFraction(a, b, x) / a
    : 1 - front * betaContinuedFraction(b, a, 1 - x) / b;
}

function posteriorReliabilityPercent(hits, n, threshold) {
  const total = Number(n);
  const success = Number(hits);
  const limit = Number(threshold);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(success) || success < 0 || success > total) return null;
  if (!Number.isFinite(limit) || limit <= 0 || limit >= 1) return null;
  const probability = 1 - regularizedIncompleteBeta(success + 1, total - success + 1, limit);
  return Math.max(0, Math.min(100, probability * 100));
}

function betaPosteriorMoments(hits, n) {
  const total = Number(n);
  const success = Number(hits);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(success) || success < 0 || success > total) return null;
  const alpha = success + 1;
  const beta = total - success + 1;
  const sum = alpha + beta;
  return {
    mean: alpha / sum,
    variance: (alpha * beta) / (sum * sum * (sum + 1)),
  };
}

// Aproxima la suma ponderada de posteriores Beta independientes mediante otra
// Beta con la misma media y varianza. Esto permite respetar exactamente los
// pesos del motor (actual/histórico y equipo A/equipo B) sin fingir que todas
// las observaciones pertenecen a una única muestra homogénea.
function weightedPosteriorReliabilityPercent(samples, threshold) {
  const limit = Number(threshold);
  if (!Number.isFinite(limit) || limit <= 0 || limit >= 1) return null;
  const valid = (samples || []).map((sample) => {
    const moments = betaPosteriorMoments(sample?.hits, sample?.n);
    const weight = Number(sample?.weight);
    return moments && Number.isFinite(weight) && weight > 0 ? { ...moments, weight } : null;
  }).filter(Boolean);
  if (!valid.length) return null;
  const totalWeight = valid.reduce((sum, sample) => sum + sample.weight, 0);
  const normalized = valid.map((sample) => ({ ...sample, weight: sample.weight / totalWeight }));
  const mean = normalized.reduce((sum, sample) => sum + sample.weight * sample.mean, 0);
  const variance = normalized.reduce((sum, sample) => sum + sample.weight ** 2 * sample.variance, 0);
  if (!(variance > 0) || !(mean > 0) || !(mean < 1)) return mean > limit ? 100 : 0;
  const concentration = mean * (1 - mean) / variance - 1;
  if (!(concentration > 0)) return mean > limit ? 100 : 0;
  const alpha = mean * concentration;
  const beta = (1 - mean) * concentration;
  const probability = 1 - regularizedIncompleteBeta(alpha, beta, limit);
  return Math.max(0, Math.min(100, probability * 100));
}

function evidenceSample(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const n = Number(evidence.n);
  if (!Number.isFinite(n) || n <= 0) return null;
  const hits = Number.isFinite(Number(evidence.hits))
    ? Number(evidence.hits)
    : Math.round(Number(evidence.rawProbability || 0) * n);
  if (!Number.isFinite(hits) || hits < 0 || hits > n) return null;
  return { hits, n };
}

function entryReliabilityPercent(entry, thresholdPercent) {
  const evidence = entry?.evidence;
  if (Array.isArray(evidence?.teams) && evidence.teams.length) {
    const teamWeight = 1 / evidence.teams.length;
    const currentShare = Number(evidence.currentShareContract ?? evidence.currentShare ?? 0.65);
    const samples = [];
    for (const team of evidence.teams) {
      const current = evidenceSample(team?.current);
      const historical = evidenceSample(team?.historical);
      if (current && historical) {
        samples.push({ ...current, weight: teamWeight * currentShare });
        samples.push({ ...historical, weight: teamWeight * (1 - currentShare) });
      } else if (current) samples.push({ ...current, weight: teamWeight });
      else if (historical) samples.push({ ...historical, weight: teamWeight });
      else {
        const direct = evidenceSample(team);
        if (direct) samples.push({ ...direct, weight: teamWeight });
      }
    }
    return weightedPosteriorReliabilityPercent(samples, Number(thresholdPercent) / 100);
  }
  const sample = evidenceSample(entry?.evidence);
  if (!sample) return null;
  return posteriorReliabilityPercent(sample.hits, sample.n, Number(thresholdPercent) / 100);
}

module.exports = {
  regularizedIncompleteBeta,
  posteriorReliabilityPercent,
  betaPosteriorMoments,
  weightedPosteriorReliabilityPercent,
  evidenceSample,
  entryReliabilityPercent,
};
