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

import reliabilityCore from './reliability-core.cjs';

export const {
  regularizedIncompleteBeta,
  posteriorReliabilityPercent,
  evidenceSample,
  entryReliabilityPercent,
} = reliabilityCore;
