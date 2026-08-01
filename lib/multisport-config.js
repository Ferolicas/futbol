// Contrato único de los deportes adicionales. Cada entrada conserva sus
// propias tablas, cache, colas y configuración entrenada; compartir este mapa
// no comparte datos ni modelos entre deportes.

const CONFIGS = {
  baseball: {
    key: 'baseball',
    slug: 'baseball',
    label: 'Baseball',
    competitionLabel: 'MLB',
    tablePrefix: 'baseball',
    provider: 'mlb',
    oddsProvider: 'baseball',
    apiSportsLeagueIds: [1],
    scoreLabel: 'carreras',
    periodKind: 'first5',
    lineStep: 0.5,
    drawAllowed: false,
    realtimeMs: 60_000,
    expectedDurationMs: 5 * 3600 * 1000,
  },
  basketball: {
    key: 'basketball',
    slug: 'baloncesto',
    label: 'Baloncesto',
    competitionLabel: 'NBA',
    tablePrefix: 'basketball',
    provider: 'nba',
    oddsProvider: 'basketball',
    // API-Basketball: NBA. Se puede ampliar por env sin mezclar el motor.
    apiSportsLeagueIds: [12],
    scoreLabel: 'puntos',
    periodKind: 'halves',
    lineStep: 0.5,
    drawAllowed: false,
    realtimeMs: 60_000,
    expectedDurationMs: 3.5 * 3600 * 1000,
  },
  american_football: {
    key: 'american_football',
    slug: 'futbol-americano',
    label: 'Fútbol americano',
    competitionLabel: 'NFL',
    tablePrefix: 'american_football',
    provider: 'api-nfl',
    oddsProvider: 'american_football',
    apiSportsLeagueIds: [1],
    scoreLabel: 'puntos',
    periodKind: 'halves',
    lineStep: 0.5,
    drawAllowed: true,
    realtimeMs: 60_000,
    expectedDurationMs: 4.5 * 3600 * 1000,
  },
};

export const MULTISPORT_KEYS = Object.freeze(Object.keys(CONFIGS));
export const MULTISPORT_CONFIGS = Object.freeze(CONFIGS);

export function normalizeSportKey(value) {
  const key = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  if (key === 'baloncesto') return 'basketball';
  if (key === 'futbol_americano' || key === 'nfl') return 'american_football';
  if (key === 'beisbol' || key === 'béisbol' || key === 'mlb') return 'baseball';
  return key;
}

export function getMultisportConfig(value) {
  const key = normalizeSportKey(value);
  const config = CONFIGS[key];
  if (!config) throw new Error(`Deporte no soportado: ${value}`);
  return config;
}

export function sportKeyFromSlug(slug) {
  return getMultisportConfig(slug).key;
}

export function isIsoDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}
