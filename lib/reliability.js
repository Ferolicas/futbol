// Fiabilidad de una probabilidad empírica.
//
// El motor de béisbol no estima con una fórmula: cuenta. Cada mercado sale de
// `hits` aciertos sobre `n` partidos comparables. Eso deja una pregunta que el
// porcentaje solo no responde: 4 de 5 y 400 de 500 son ambos "80%", pero uno se
// sostiene y el otro no.
//
// Fiabilidad = P(la tasa real ≥ umbral | los datos observados), con posterior
// Beta(hits+1, n-hits+1) — el Beta-binomial estándar con prior uniforme. Decir
// "fiabilidad 90%" significa literalmente: hay un 90% de probabilidad de que el
// mercado sea de verdad tan bueno como se anuncia. Con 4 de 5 la fiabilidad de
// superar el 70% es del 65%; con 400 de 500, del 100%.

/** log Γ(x) — Lanczos. Base de la función beta incompleta. */
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

/** Fracción continua de Lentz para la beta incompleta. */
function betaContinuedFraction(a, b, x) {
  const FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;  if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;  if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

/** I_x(a,b) — beta incompleta regularizada = CDF de Beta(a,b) en x. */
export function regularizedIncompleteBeta(a, b, x) {
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

/**
 * Fiabilidad en % de que la tasa real supere `threshold` (0-1), dados `hits`
 * aciertos en `n` observaciones. Devuelve null si no hay muestra que auditar:
 * sin `n` no hay fiabilidad que demostrar y el mercado no debe publicarse.
 */
export function posteriorReliabilityPercent(hits, n, threshold) {
  const total = Number(n);
  const success = Number(hits);
  const limit = Number(threshold);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(success) || success < 0 || success > total) return null;
  if (!Number.isFinite(limit) || limit <= 0 || limit >= 1) return null;
  // P(p > limit) = 1 − CDF_Beta(limit) con posterior Beta(hits+1, n−hits+1).
  const probability = 1 - regularizedIncompleteBeta(success + 1, total - success + 1, limit);
  return Math.max(0, Math.min(100, probability * 100));
}

/**
 * Extrae (hits, n) de la evidencia que adjunta el motor empírico. Los mercados
 * de equipo la traen vía `audit()` y los de jugador vía su propio recuento;
 * ambos exponen las mismas dos claves.
 */
export function evidenceSample(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const n = Number(evidence.n);
  if (!Number.isFinite(n) || n <= 0) return null;
  const hits = Number.isFinite(Number(evidence.hits))
    ? Number(evidence.hits)
    // Sin `hits` explícito se reconstruye del ratio observado; redondear es
    // exacto porque el ratio salió de una división entera.
    : Math.round(Number(evidence.rawProbability || 0) * n);
  if (!Number.isFinite(hits) || hits < 0 || hits > n) return null;
  return { hits, n };
}

/**
 * Fiabilidad de una entrada de probabilidad del motor ({probability,
 * rawProbability, evidence}) frente a un umbral en porcentaje.
 */
export function entryReliabilityPercent(entry, thresholdPercent) {
  const sample = evidenceSample(entry?.evidence);
  if (!sample) return null;
  return posteriorReliabilityPercent(sample.hits, sample.n, Number(thresholdPercent) / 100);
}
