// Fiabilidad de una probabilidad empírica.
//
// Los motores empíricos no estiman con una fórmula opaca: cuentan. Cada mercado sale de
// `hits` aciertos sobre `n` partidos comparables. Eso deja una pregunta que el
// porcentaje solo no responde: 4 de 5 y 400 de 500 son ambos "80%", pero uno se
// sostiene y el otro no.
//
// Fiabilidad = P(la tasa real ≥ umbral | los datos observados), con posterior
// Beta(hits+1, n-hits+1) — el Beta-binomial estándar con prior uniforme. Decir
// "fiabilidad 90%" significa literalmente: hay un 90% de probabilidad de que el
// mercado sea de verdad tan bueno como se anuncia. Con 4 de 5 la fiabilidad de
// superar el 70% es del 65%; con 400 de 500, del 100%. Cuando existen
// temporada actual/histórico o dos participantes, sus posteriores se combinan
// con los mismos pesos del porcentaje (65/35 y 50/50).

import reliabilityCore from './reliability-core.cjs';

export const {
  regularizedIncompleteBeta,
  posteriorReliabilityPercent,
  betaPosteriorMoments,
  weightedPosteriorReliabilityPercent,
  evidenceSample,
  entryReliabilityPercent,
} = reliabilityCore;
