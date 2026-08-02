// Política comercial única para decidir qué resultados YA CALCULADOS pueden
// mostrarse como opciones de apuesta. Estas constantes no intervienen en los
// motores ni alteran probabilidades: filtran únicamente su catálogo público.

export const BASEBALL_RECOMMENDATION_MIN_PROBABILITY = 70;
export const BASEBALL_DAILY_MIN_PROBABILITY = 90;
export const FOOTBALL_RECOMMENDATION_MIN_RELIABILITY = 90;

export function reliabilityPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const percent = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, percent));
}

// Comparación sin redondeo: 89,999% no se convierte artificialmente en 90%.
export function meetsFootballReliability(value) {
  const percent = reliabilityPercent(value);
  return percent != null && percent + Number.EPSILON >= FOOTBALL_RECOMMENDATION_MIN_RELIABILITY;
}

function combinedProbability(selections) {
  return selections.reduce(
    (value, selection) => value * (Number(selection.rawProbability ?? selection.probability) / 100),
    1,
  ) * 100;
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
        return {
          ...item,
          confidence: reliabilityPercent(confidence),
          sampleN: item?.sampleN ?? evidence?.n ?? null,
        };
      })
      .filter(Boolean);
  };
  const selections = reliable(combinada.selections);
  const reliableSelectable = reliable(combinada.selectable);
  // Los análisis v20 ya guardaban fiabilidad en `selections`, pero no en el
  // catálogo ampliado `selectable`. No podemos publicar esas líneas huérfanas;
  // sí podemos unir el catálogo recuperado con el subconjunto principal que
  // demuestra >=90. El ID canónico evita duplicar una misma línea.
  const seenSelectable = new Set();
  const selectable = [...reliableSelectable, ...selections].filter((item) => {
    const key = item?.id || JSON.stringify(item);
    if (seenSelectable.has(key)) return false;
    seenSelectable.add(key);
    return true;
  });
  const combinedOdd = selections.length
    ? selections.reduce((value, selection) => value * Number(selection.odd || 1), 1)
    : null;
  const probability = selections.length ? combinedProbability(selections) : 0;
  return {
    ...combinada,
    selections,
    selectable,
    combinedOdd: combinedOdd == null ? null : Math.round(combinedOdd * 100) / 100,
    combinedProbability: Math.round((probability + Number.EPSILON) * 100) / 100,
    highRisk: selections.length > 0 && probability < 60,
    hasRealOdds: selectable.length > 0,
    minimumReliability: FOOTBALL_RECOMMENDATION_MIN_RELIABILITY,
  };
}
