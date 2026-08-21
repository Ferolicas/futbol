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
  const sample = evidenceSample(entry?.evidence);
  if (!sample) return null;
  return posteriorReliabilityPercent(sample.hits, sample.n, Number(thresholdPercent) / 100);
}

module.exports = {
  regularizedIncompleteBeta,
  posteriorReliabilityPercent,
  evidenceSample,
  entryReliabilityPercent,
};
