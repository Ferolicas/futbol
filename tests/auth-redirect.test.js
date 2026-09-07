const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('el login conserva la ruta privada completa y rechaza redirecciones externas', () => {
  const proxy = fs.readFileSync(path.join(__dirname, '../proxy.js'), 'utf8');
  const signIn = fs.readFileSync(path.join(__dirname, '../app/sign-in/[[...sign-in]]/page.js'), 'utf8');
  assert.match(proxy, /searchParams\.set\('redirect_url', destination\)/);
  assert.match(proxy, /`\$\{pathname\}\$\{request\.nextUrl\.search\}`/);
  assert.match(signIn, /requestedRedirect\?\.startsWith\('\/'\)/);
  assert.match(signIn, /!requestedRedirect\.startsWith\('\/\/'\)/);
  assert.match(signIn, /safeRedirect \|\| '\/dashboard'/);
});
