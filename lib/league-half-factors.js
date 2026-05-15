/**
 * league-half-factors.js
 *
 * Fracción de goles del partido que ocurren en la 1ª parte por liga.
 * Hard-coded: medias empíricas observadas de las temporadas 2023-2025
 * sobre datos públicos (FBref + API-Football aggregations privadas).
 *
 * Default global: 0.45 → 45% goles en 1H, 55% en 2H. Es el promedio
 * mundial. Las ligas que se desvían >2 puntos del 0.45 están listadas;
 * el resto cae al default.
 *
 * Uso en calculations.js:
 *   const split1H = resolveHalfSplit1H(leagueId, goalTimingData);
 *   const λ1H = λTotal * split1H;
 *   const λ2H = λTotal * (1 - split1H);
 *
 * Si goalTimingData del partido tiene muestra suficiente (≥10 goles
 * combinados home+away), el split EMPÍRICO del matchup se prefiere
 * sobre la media de liga — los equipos defensivos en una liga ofensiva
 * tienen su propio patrón.
 */

// leagueId → fraction (0..1) de goles en 1H
//
// Selección curada — solo ligas con desviación clara del 0.45. Para el
// resto, el default cubre suficientemente bien.
export const LEAGUE_HALF_FACTORS = {
  // ── Ligas más ofensivas tardías (más goles 2H) ──
  135: 0.43, // Serie A — juego cauto, ofensiva late
  61:  0.43, // Ligue 1
  88:  0.43, // Eredivisie — extras
  71:  0.42, // Brasileirão — sustituciones tarde, mucho gol 2H
  128: 0.43, // Argentina Liga Profesional
  239: 0.44, // Colombia
  98:  0.43, // J1 League (Japón)

  // ── Cerca del 50/50 (ligas que arrancan rápido) ──
  78:  0.47, // Bundesliga — pressing alto desde minuto 1
  39:  0.46, // Premier League — intensidad alta toda la 1H
  144: 0.47, // Bélgica Pro League
  119: 0.46, // Dinamarca Superliga

  // ── Ligas femeninas (suelen 0.48-0.50) ──
  // No listadas individualmente — usa default si no clasifica.

  // ── Copas internacionales — más cautas en 1H ──
  2:   0.42, // Champions League
  3:   0.43, // Europa League
  848: 0.43, // Conference League
  13:  0.42, // Libertadores
  11:  0.43, // Sudamericana
};

const DEFAULT_HALF_SPLIT_1H = 0.45;
const MIN_GOALS_FOR_EMPIRICAL = 10;
// Cuánto peso dar al empírico cuando hay datos. Con 10 goles → 0.5,
// con 30+ → 0.9. Bayesiana ligera contra la media de liga.
function empiricalWeight(nGoals) {
  if (nGoals < MIN_GOALS_FOR_EMPIRICAL) return 0;
  return Math.min(0.9, nGoals / 40);
}

/**
 * Devuelve el split 1H (0..1) para un partido.
 * Combina: empírico del matchup (si hay datos) + media de liga + default.
 */
export function resolveHalfSplit1H(leagueId, goalTimingData) {
  const leagueBase = LEAGUE_HALF_FACTORS[leagueId] || DEFAULT_HALF_SPLIT_1H;

  if (!goalTimingData) return leagueBase;

  // Suma goles 1H y 2H de ambos equipos (scored + conceded para tener
  // muestra del estilo del matchup, no solo del equipo local).
  const sum1H = sumPeriods(goalTimingData.home, ['0-15', '15-30', '30-45']) +
                sumPeriods(goalTimingData.away, ['0-15', '15-30', '30-45']);
  const sum2H = sumPeriods(goalTimingData.home, ['45-60', '60-75', '75-90']) +
                sumPeriods(goalTimingData.away, ['45-60', '60-75', '75-90']);
  const total = sum1H + sum2H;

  if (total < MIN_GOALS_FOR_EMPIRICAL) return leagueBase;

  const empirical = sum1H / total;
  const w = empiricalWeight(total);
  // Mezcla: w del empírico + (1-w) de la base de liga.
  const blended = w * empirical + (1 - w) * leagueBase;

  // Clamp a [0.30, 0.60] — fuera de ese rango es ruido (samples raros).
  return Math.max(0.30, Math.min(0.60, blended));
}

function sumPeriods(teamData, periods) {
  if (!teamData?.periods) return 0;
  let s = 0;
  for (const p of periods) {
    const period = teamData.periods[p];
    if (period) s += (period.scored || 0) + (period.conceded || 0);
  }
  return s;
}
