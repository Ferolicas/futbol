const test = require('node:test');
const assert = require('node:assert/strict');

const {
  payloadQuality, responseSize, footballApiPath,
  classifyApiErrorText,
  dailyLimitCooldownMs,
  isCriticalPriority,
  DAILY_LIMIT_RECHECK_MS,
  SLOT_MS, RATE_PER_MINUTE, FALLBACK_RATE_PER_MINUTE,
} = require('../lib/football-api-client.cjs');

test('rechaza errores HTTP/rate-limit y distingue vacío válido de datos', () => {
  assert.equal(payloadQuality({ __http: 429, response: [] }), 0);
  assert.equal(payloadQuality({ errors: { rateLimit: 'Too many requests' }, response: [] }), 0);
  assert.equal(payloadQuality({ errors: {}, response: [] }), 1);
  assert.equal(payloadQuality({ errors: {}, response: [{ id: 1 }] }), 2);
  assert.equal(payloadQuality({ fixture: { id: 1 } }), 2);
  assert.equal(responseSize({ response: { league: { id: 39 } } }), 1);
});

test('la cuota diaria abre circuito sin reintentos y el límite por minuto sí reintenta', () => {
  assert.deepEqual(
    classifyApiErrorText('You have reached the request limit for the day'),
    { code: 'DAILY_LIMIT', retryable: false },
  );
  assert.deepEqual(
    classifyApiErrorText('Too many requests. You have exceeded the limit of requests per minute'),
    { code: 'RATE_LIMIT', retryable: true },
  );
  assert.equal(
    dailyLimitCooldownMs(Date.UTC(2026, 7, 1, 12, 0, 0)),
    DAILY_LIMIT_RECHECK_MS,
  );
});

test('no existe reserva preventiva; la prioridad solo gobierna la sonda tras agotamiento real', () => {
  assert.equal(isCriticalPriority('live'), true);
  assert.equal(isCriticalPriority('fixtures'), true);
  assert.equal(isCriticalPriority('results'), true);
  assert.equal(isCriticalPriority('standard'), false);
});

test('el ritmo por defecto queda por debajo de 450 solicitudes/minuto', () => {
  assert.ok(RATE_PER_MINUTE <= 420);
  assert.ok(SLOT_MS >= Math.ceil(60_000 / 420));
  assert.ok(FALLBACK_RATE_PER_MINUTE <= 100);
});

test('reconstruye de forma segura las rutas del ledger de reintentos', () => {
  assert.equal(footballApiPath('fixtures/statistics', 123), '/fixtures/statistics?fixture=123');
  assert.equal(footballApiPath('teams/statistics', 7, 's:2026:l:39'), '/teams/statistics?team=7&league=39&season=2026');
  assert.equal(footballApiPath('teams/statistics', 7, 'l:39', 2025), '/teams/statistics?team=7&league=39&season=2025');
  assert.equal(footballApiPath('players', 7, 'p:2', 2025), '/players?team=7&season=2025&page=2');
  assert.equal(footballApiPath('injuries', 7, 'team:2026', 2026), '/injuries?team=7&season=2026');
  assert.equal(footballApiPath('../secret', 1), null);
});
