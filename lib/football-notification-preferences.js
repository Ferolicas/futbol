export const FOOTBALL_NOTIFICATION_OPTIONS = Object.freeze([
  Object.freeze({ key: 'goals', label: 'Goles', icon: '⚽' }),
  Object.freeze({ key: 'corners', label: 'Córners', icon: '🚩' }),
  Object.freeze({ key: 'shots', label: 'Remates', icon: '◉' }),
  Object.freeze({ key: 'shots_on_target', label: 'Remates a puerta', icon: '🎯' }),
  Object.freeze({ key: 'cards', label: 'Tarjetas', icon: '🟨' }),
  Object.freeze({ key: 'penalties', label: 'Penaltis', icon: '🅿️' }),
  Object.freeze({ key: 'substitutions', label: 'Cambios', icon: '🔄' }),
  Object.freeze({ key: 'fouls', label: 'Faltas', icon: '⚠️' }),
]);

export const ALL_FOOTBALL_NOTIFICATION_PREFERENCES = Object.freeze(
  FOOTBALL_NOTIFICATION_OPTIONS.map((option) => option.key),
);

const ALLOWED_PREFERENCES = new Set(ALL_FOOTBALL_NOTIFICATION_PREFERENCES);

export function normalizeFootballNotificationPreferences(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item || '').trim())
    .filter((item) => ALLOWED_PREFERENCES.has(item)))];
}

export function footballNotificationCategoryForEvent(type) {
  switch (type) {
    case 'goal':
    case 'goal_cancelled':
      return 'goals';
    case 'corner':
      return 'corners';
    case 'shot':
      return 'shots';
    case 'shot_on_target':
      return 'shots_on_target';
    case 'yellow':
    case 'red':
      return 'cards';
    case 'penalty':
      return 'penalties';
    case 'substitution':
      return 'substitutions';
    case 'foul':
      return 'fouls';
    default:
      return null;
  }
}

export function filterFootballNotificationEvents(events, preferences) {
  const enabled = new Set(normalizeFootballNotificationPreferences(preferences));
  return (Array.isArray(events) ? events : []).filter((event) => {
    const category = footballNotificationCategoryForEvent(event?.type);
    if (category !== null && enabled.has(category)) return true;
    // Un penalti convertido llega primero como gol oficial. Quien eligió
    // "Penaltis" debe recibirlo aunque no haya activado todos los goles.
    return event?.type === 'goal'
      && /GOL DE PENALTI/i.test(String(event?.detail || ''))
      && enabled.has('penalties');
  });
}
