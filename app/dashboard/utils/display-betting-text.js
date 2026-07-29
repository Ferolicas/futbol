/**
 * Traduce términos de mercados únicamente para presentación.
 *
 * Los IDs, claves, respuestas API y cálculos conservan `over` / `under`.
 * Esta función se aplica al texto justo antes de renderizarlo y también cubre
 * nombres antiguos que puedan llegar desde caché o combinadas guardadas.
 */
export function displayBettingText(value) {
  if (typeof value !== 'string') return value;

  return value
    .replace(/\bO\s*\/\s*U\b/gi, 'Más de / Menos de')
    .replace(/\bOver\s*\/\s*Under\b/gi, 'Más de / Menos de')
    .replace(/\bOver\b/gi, 'Más de')
    .replace(/\bUnder\b/gi, 'Menos de');
}
