const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('la solicitud desde el panel solo envía un enlace al correo registrado', () => {
  const route = read('app/api/auth/change-password/route.js');
  const widget = read('app/dashboard/chat-widget.js');
  assert.match(route, /issuePasswordReset/);
  assert.doesNotMatch(route, /password_hash|oldPassword|newPassword/);
  assert.doesNotMatch(widget, /currentPassword|newPassword|confirmPassword/);
  assert.match(widget, /api\/auth\/change-password/);
});

test('el reset confirma ambas claves, consume el token y revoca sesiones', () => {
  const route = read('app/api/auth/reset-password/route.js');
  const reset = read('lib/password-reset.js');
  assert.match(route, /password !== confirmPassword/);
  assert.match(route, /takePasswordReset\(token\)/);
  assert.match(route, /DELETE FROM public\.auth_sessions/);
  assert.match(reset, /redisTake/);
  assert.match(reset, /sha256/);
});

test('la política respeta el límite seguro de bcrypt en UTF-8', async () => {
  const { validateNewPassword } = await import('../lib/password-policy.js');
  assert.equal(validateNewPassword('1234567').success, false);
  assert.equal(validateNewPassword('correct horse battery staple').success, true);
  assert.equal(validateNewPassword('á'.repeat(37)).success, false);
});

test('los crons aceptan Bearer y rechazan secretos en URL o cabeceras heredadas', async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'a'.repeat(48);
  try {
    const { isCronAuthorized } = await import('../lib/internal-auth.js');
    const request = (authorization, url = 'https://cfanalisis.com/api/cron/daily') => ({
      url,
      headers: new Headers(authorization ? { authorization } : { 'x-cron-secret': 'a'.repeat(48) }),
    });
    assert.equal(isCronAuthorized(request(`Bearer ${'a'.repeat(48)}`)), true);
    assert.equal(isCronAuthorized(request(null, `https://cfanalisis.com/api/cron/daily?secret=${'a'.repeat(48)}`)), false);
    assert.equal(isCronAuthorized(request(null)), false);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test('la telemetría live exige firma y expiración', async () => {
  const previous = process.env.WORKER_SECRET;
  process.env.WORKER_SECRET = 'worker-secret-for-tests-with-more-than-32-characters';
  try {
    const { createLiveTelemetryToken, verifyLiveTelemetryToken } = await import('../lib/live-telemetry-token.js');
    const signed = createLiveTelemetryToken(123, '45+2');
    assert.equal(verifyLiveTelemetryToken(123, '45+2', signed.expiresAt, signed.token), true);
    assert.equal(verifyLiveTelemetryToken(124, '45+2', signed.expiresAt, signed.token), false);
    assert.equal(verifyLiveTelemetryToken(123, '45+2', Date.now() - 1, signed.token), false);
  } finally {
    if (previous === undefined) delete process.env.WORKER_SECRET;
    else process.env.WORKER_SECRET = previous;
  }
});
