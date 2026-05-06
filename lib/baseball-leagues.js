// Baseball leagues — IDs from api-sports.io v1 baseball
// https://www.api-baseball.com/documentation/v1
//
// Coverage: principales primeras divisiones del mundo + segundas divisiones
// más relevantes para apuestas. Orden por relevancia comercial.
//
// IMPORTANTE: los IDs son los oficiales de api-baseball.com. Si la API
// devuelve códigos distintos para tu cuenta, ajustarlos aquí.

export const BASEBALL_LEAGUES = {
  // ============ NORTH AMERICA ============
  1:  { country: 'USA',           name: 'MLB',                 division: 1, type: 'season' },
  17: { country: 'USA',           name: 'MiLB Triple-A',       division: 2, type: 'season' },
  18: { country: 'USA',           name: 'MiLB Double-A',       division: 2, type: 'season' },

  // ============ ASIA ============
  2:  { country: 'Japan',         name: 'NPB',                 division: 1, type: 'season' },
  5:  { country: 'South Korea',   name: 'KBO League',          division: 1, type: 'season' },
  6:  { country: 'Taiwan',        name: 'CPBL',                division: 1, type: 'season' },

  // ============ LATIN AMERICA — VERANO ============
  9:  { country: 'Mexico',        name: 'LMB',                 division: 1, type: 'season' },

  // ============ LATIN AMERICA — INVIERNO (caribe) ============
  11: { country: 'Mexico',        name: 'LMP (Pacífico)',      division: 1, type: 'winter' },
  12: { country: 'Dominican Rep', name: 'LIDOM',               division: 1, type: 'winter' },
  13: { country: 'Venezuela',     name: 'LVBP',                division: 1, type: 'winter' },
  15: { country: 'Puerto Rico',   name: 'LBPRC',               division: 1, type: 'winter' },

  // ============ AUSTRALIA ============
  14: { country: 'Australia',     name: 'ABL',                 division: 1, type: 'season' },

  // ============ INTERNATIONAL ============
  21: { country: 'World',         name: 'World Baseball Classic', division: 0, type: 'tournament' },
};

export const BASEBALL_LEAGUE_IDS = Object.keys(BASEBALL_LEAGUES).map(Number);

export const BASEBALL_FLAGS = {
  USA: '🇺🇸',
  Japan: '🇯🇵',
  'South Korea': '🇰🇷',
  Taiwan: '🇹🇼',
  Mexico: '🇲🇽',
  'Dominican Rep': '🇩🇴',
  Venezuela: '🇻🇪',
  'Puerto Rico': '🇵🇷',
  Australia: '🇦🇺',
  World: '🌍',
};

// Calendar-year leagues: la temporada coincide con el año calendario.
// Las ligas de invierno latinoamericanas cruzan año (oct-feb).
const CALENDAR_YEAR_LEAGUES = new Set([1, 17, 18, 2, 5, 6, 9, 14]);

export function currentBaseballSeason(leagueId) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const id = Number(leagueId);

  if (CALENDAR_YEAR_LEAGUES.has(id)) {
    return year;
  }

  // Ligas de invierno: Oct-Feb pertenecen a la temporada del año que termina (ej. 2025-26 = season 2025)
  if ([11, 12, 13, 15].includes(id)) {
    return month >= 9 ? year : year - 1;
  }

  return year;
}

export function getBaseballLeagueMeta(leagueId) {
  return BASEBALL_LEAGUES[Number(leagueId)] || null;
}
