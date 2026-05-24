/**
 * Constantes globales compartidas entre frontend, endpoints y crons.
 *
 * MIN_DISPLAY_ODDS: cuota mínima que el frontend acepta mostrar en cualquier
 * lista de selecciones (recomendaciones, combinada del día, análisis,
 * historial, custom combinada). Cuotas inferiores se calculan y guardan en
 * BD igual (el backend NO filtra), pero NO se presentan al usuario porque
 * el ROI no es atractivo.
 *
 * Los endpoints que sirven picks al frontend aceptan un query param
 * `min_odds=X` para overridear (default 1.20).
 */
export const MIN_DISPLAY_ODDS = 1.20;
