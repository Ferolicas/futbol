const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('la identidad del rate limit usa el peer añadido al final por el proxy', async () => {
  const { clientIp } = await import('../lib/ratelimit-redis.js');
  const headers = new Headers({
    'x-forwarded-for': '203.0.113.99, 198.51.100.7',
  });
  assert.equal(clientIp({ headers }), '198.51.100.7');
});

test('los logs convierten controles y saltos en una sola línea acotada', async () => {
  const { safeLogValue } = await import('../lib/safe-log.js');
  assert.equal(safeLogValue('visible\r\nFAKE\u0000LOG'), 'visible  FAKE LOG');
  assert.equal(safeLogValue('123456', 4), '1234');
});

test('pick-image bloquea redirects, limita bytes y aplica rate limit fail-closed', () => {
  const source = read('app/api/pick-image/route.js');
  assert.equal(source.includes("redirect: 'error'"), true);
  assert.equal(source.includes('MAX_REMOTE_IMAGE_BYTES'), true);
  assert.equal(source.includes('/^\\/football\\/teams\\/([0-9]{1,12})\\.png$/'), true);
  assert.equal(source.includes('TRUSTED_RASTER_TYPES'), true);
  assert.equal(source.includes("redisRateLimit('pick-image'"), true);
  assert.equal(source.includes('failClosed: true'), true);
});

test('las fotos remotas exigen PNG y escritura temporal criptográfica', () => {
  const source = read('lib/player-photos.js');
  assert.equal(source.includes("redirect: 'error'"), true);
  assert.equal(source.includes("!== 'image/png'"), true);
  assert.equal(source.includes('randomUUID()'), true);
});

test('los migradores Supabase que enviaban SQL local ya no existen', () => {
  assert.equal(fs.existsSync(path.join(root, 'scripts/run-migration.mjs')), false);
  assert.equal(fs.existsSync(path.join(root, 'scripts/run-new-tables.mjs')), false);
});
