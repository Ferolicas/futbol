import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let preferences;

test.before(async () => {
  preferences = await import('../lib/football-notification-preferences.js');
});

test('normaliza categorías y descarta valores desconocidos', () => {
  assert.deepEqual(
    preferences.ALL_FOOTBALL_NOTIFICATION_PREFERENCES,
    ['goals', 'corners', 'shots', 'shots_on_target', 'cards', 'penalties', 'substitutions', 'fouls'],
  );
  assert.deepEqual(
    preferences.normalizeFootballNotificationPreferences(['goals', 'cards', 'goals', 'fouls', 'offsides']),
    ['goals', 'cards', 'fouls'],
  );
  assert.deepEqual(preferences.normalizeFootballNotificationPreferences(null), []);
});

test('filtra cada evento del bundle según las preferencias del favorito', () => {
  const events = [
    { type: 'goal', detail: 'Gol' },
    { type: 'goal_cancelled', detail: 'Gol anulado' },
    { type: 'corner', detail: 'Córner' },
    { type: 'yellow', detail: 'Amarilla' },
    { type: 'red', detail: 'Roja' },
    { type: 'shot', detail: 'Remate' },
    { type: 'shot_on_target', detail: 'Remate a puerta' },
    { type: 'penalty', detail: 'Penalti' },
    { type: 'substitution', detail: 'Cambio' },
    { type: 'foul', detail: 'Falta' },
  ];

  assert.deepEqual(
    preferences.filterFootballNotificationEvents(events, ['goals', 'cards', 'substitutions']).map((event) => event.type),
    ['goal', 'goal_cancelled', 'yellow', 'red', 'substitution'],
  );
  assert.deepEqual(preferences.filterFootballNotificationEvents(events, []), []);
  assert.deepEqual(
    preferences.filterFootballNotificationEvents(events, ['fouls']).map((event) => event.type),
    ['foul'],
  );
});

test('un gol de penalti también pertenece a la preferencia Penaltis', () => {
  const events = [
    { type: 'goal', detail: '⚽ GOL DE PENALTI · Jugador' },
    { type: 'goal', detail: '⚽ GOL · Jugador' },
  ];
  assert.deepEqual(
    preferences.filterFootballNotificationEvents(events, ['penalties']).map((event) => event.detail),
    ['⚽ GOL DE PENALTI · Jugador'],
  );
});

test('favorites persiste TEXT[] con pg nativo y no con el serializador JSON legacy', () => {
  const route = readFileSync(join(process.cwd(), 'app/api/favorites/route.js'), 'utf8');
  assert.match(route, /\$3::text\[\]/);
  assert.match(route, /pgQuery\(/);
  assert.doesNotMatch(route, /\.upsert\(\{[\s\S]*notification_preferences/);
});
