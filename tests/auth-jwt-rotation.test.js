const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('la firma usa solo la clave actual y la verificación admite la anterior', () => {
  const session = read('lib/auth-session.js');
  const proxy = read('proxy.js');
  assert.match(session, /sign\(getSigningSecret\(\)\)/);
  assert.match(session, /AUTH_JWT_SECRET_PREVIOUS/);
  assert.match(session, /for \(const secret of getVerificationSecrets\(\)\)/);
  assert.match(proxy, /AUTH_JWT_SECRET_PREVIOUS/);
  assert.match(proxy, /for \(const secret of getJwtSecrets\(\)\)/);
});

test('el rotador no imprime secretos y conserva permisos del entorno', () => {
  const script = read('scripts/vps/rotate-auth-jwt-secret.sh');
  assert.match(script, /openssl rand -hex 48/);
  assert.match(script, /AUTH_JWT_SECRET_PREVIOUS=/);
  assert.match(script, /chmod --reference/);
  assert.doesNotMatch(script, /set -x/);
});
