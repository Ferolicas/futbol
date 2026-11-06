import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('uso personal: la raíz es un 404 con un único aviso y sin enlaces', () => {
  assert.match(read('app/page.js'), /notFound\(\)/);
  const notFound = read('app/not-found.js');
  assert.match(notFound, /Esta página no existe/);
  assert.doesNotMatch(notFound, /href=|<a |Link/);
});

test('uso personal: solo el propietario obtiene sesión y el registro está cerrado', () => {
  assert.match(read('lib/auth-pg.js'), /JOIN public\.user_profiles p ON p\.id = u\.id AND p\.role IN \('admin', 'owner'\)/);
  const login = read('app/api/auth/login/route.js');
  assert.match(login, /if \(!\['admin', 'owner'\]\.includes\(profile\.role\)\) \{\s*return Response\.json\(\{ error: 'Email o contraseña incorrectos' \}, \{ status: 401 \}\);/);
  assert.doesNotMatch(login, /createAuthenticatedSession/, 'no existe un camino de sesión sin segundo factor');
  assert.match(read('app/api/register/route.js'), /if \(REGISTRATION_CLOSED\) return Response\.json\(\{ error: 'Not found' \}, \{ status: 404 \}\);/);
  const proxy = read('proxy.js');
  for (const path of ['/sign-up', '/planes', '/pago', '/rendimiento', '/api/register', '/api/public', '/api/checkout']) {
    assert.ok(proxy.includes(`'${path}'`), `${path} debe estar cerrado en el proxy`);
  }
});
