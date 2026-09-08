// Política comercial única para decidir qué resultados YA CALCULADOS pueden
// mostrarse como opciones de apuesta. Estas constantes no intervienen en los
// motores ni alteran probabilidades: filtran únicamente su catálogo público.

export const BASEBALL_RECOMMENDATION_MIN_PROBABILITY = 65;
// Apuesta del Día de béisbol: entra TODO mercado (carreras, hits, jugadores,
// lanzadores, entradas) que llegue al 70% de probabilidad Y demuestre un 90% de
// fiabilidad — es decir, que la muestra histórica respalde que ese 70% es real
// y no el espejismo de cuatro partidos. Ver lib/reliability.js.
export const BASEBALL_DAILY_MIN_PROBABILITY = 70;
export const BASEBALL_DAILY_MIN_RELIABILITY = 90;
export const FOOTBALL_RECOMMENDATION_MIN_RELIABILITY = 90;
export const FOOTBALL_DAILY_FRONTEND_MIN_PROBABILITY = 90;
export const FOOTBALL_DAILY_FRONTEND_MIN_ODD = 1.20;
export const RECOMMENDATION_MIN_EXPECTED_VALUE = 0.05;
export const DAILY_MIN_EXPECTED_VALUE = 0.10;

export function reliabilityPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const percent = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, percent));
}

// Comparación sin redondeo: 89,999% no se convierte artificialmente en 90%.
export function meetsReliability(value, minimum) {
  const percent = reliabilityPercent(value);
  const threshold = Number(minimum);
  return percent != null
    && Number.isFinite(threshold)
    && percent + Number.EPSILON >= threshold;
}

export function meetsFootballReliability(value) {
  return meetsReliability(value, FOOTBALL_RECOMMENDATION_MIN_RELIABILITY);
}

export function isFootballFrontendDailyPickEligible(selection) {
  const probability = Number(selection?.rawProbability ?? selection?.probability);
  const odd = Number(selection?.odd);
  const expectedValue = Number(selection?.expectedValue);
  return meetsFootballReliability(selection?.confidence)
    && selection?.validationStatus === 'calibrated'
    && selection?.dailyEligible === true
    && Number.isFinite(probability)
    && probability + Number.EPSILON >= FOOTBALL_DAILY_FRONTEND_MIN_PROBABILITY
    && Number.isFinite(odd)
    && odd + Number.EPSILON >= FOOTBALL_DAILY_FRONTEND_MIN_ODD
    && Number.isFinite(expectedValue)
    && expectedValue + Number.EPSILON >= DAILY_MIN_EXPECTED_VALUE;
}

// Defensa de frontera para caches o filas antiguas. Las estadísticas viven
// fuera de `combinada` y permanecen intactas; solo se vacían opciones que no
// puedan demostrar la fiabilidad exigida por el contrato vigente.
export function sanitizeFootballCombinada(combinada, scored = null) {
  if (!combinada || typeof combinada !== 'object') return combinada || null;
  const canonical = combinada.source === 'context-engine';
  const reliable = (items) => {
    if (!canonical || !Array.isArray(items)) return [];
    return items
      .map((item) => {
        const evidence = scored?.[item?.id];
        const confidence = item?.confidence ?? evidence?.confidence ?? evidence?.conf;
        if (!meetsFootballReliability(confidence)) return null;
        const validationStatus = item?.validationStatus
          ?? evidence?.validation?.decision?.status
          ?? null;
        const expectedValue = Number(item?.expectedValue);
        if (validationStatus !== 'calibrated') return null;
        if (!Number.isFinite(expectedValue)
            || expectedValue + Number.EPSILON < RECOMMENDATION_MIN_EXPECTED_VALUE) return null;
        return {
          ...item,
          confidence: reliabilityPercent(confidence),
          validationStatus,
          expectedValue,
          sampleN: item?.sampleN ?? evidence?.n ?? null,
        };
      })
      .filter(Boolean);
  };
  const selections = reliable(combinada.selections);
  const reliableSelectable = reliable(combinada.selectable);
  // No publicamos líneas huérfanas de evidencia; unimos el catálogo validado
  // con el subconjunto principal y deduplicamos por ID canónico.
  const seenSelectable = new Set();
  const selectable = [...reliableSelectable, ...selections].filter((item) => {
    const key = item?.id || JSON.stringify(item);
    if (seenSelectable.has(key)) return false;
    seenSelectable.add(key);
    return true;
  });
  // Este objeto pertenece a un único fixture. Sus líneas pueden estar muy
  // correlacionadas o ser incompatibles; sin precio Bet Builder oficial no se
  // publica una cuota/probabilidad conjunta inventada.
  return {
    ...combinada,
    selections,
    selectable,
    combinedOdd: null,
    combinedProbability: null,
    correlationStatus: selections.length ? 'same-fixture-not-priced' : 'not-priced',
    highRisk: false,
    hasRealOdds: selectable.length > 0,
    minimumReliability: FOOTBALL_RECOMMENDATION_MIN_RELIABILITY,
  };
}
