const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('el deploy queda bloqueado por tests, auditoría, tipado y builds', () => {
  const deploy = read('.github/workflows/deploy.yml');
  assert.match(deploy, /needs: quality/);
  assert.match(deploy, /npm audit --omit=dev --audit-level=high/);
  assert.match(deploy, /npm test/);
  assert.match(deploy, /npm run typecheck && npm run build/);
});

test('DAST y carga solo entran a staging privado por túnel', () => {
  const dast = read('.github/workflows/dast.yml');
  const load = read('.github/workflows/load.yml');
  const script = read('tests/load/staging-smoke.js');
  for (const source of [dast, load]) {
    assert.match(source, /-L 3100:127\.0\.0\.1:3100/);
    assert.match(source, /StrictHostKeyChecking=yes/);
    assert.doesNotMatch(source, /https:\/\/cfanalisis\.com/);
  }
  assert.match(script, /baseUrl !== 'http:\/\/127\.0\.0\.1:3100'/);
  assert.match(script, /vus > 10/);
});

test('staging no hereda secretos LIVE y solo escucha en loopback', () => {
  const provision = read('scripts/vps/provision-staging.sh');
  const deploy = read('scripts/vps/deploy-staging.sh');
  assert.match(provision, /STRIPE_SECRET_KEY=/);
  assert.match(provision, /MERCADOPAGO_ACCESS_TOKEN=/);
  assert.match(provision, /LOCAL_REDIS_DB=15/);
  assert.match(deploy, /HOSTNAME: '127\.0\.0\.1'/);
  assert.match(deploy, /PORT: 3100/);
});

test('los backups se validan, tienen checksum y simulacro aislado', () => {
  const postgres = read('scripts/vps/pg_backup.sh');
  const redis = read('scripts/vps/redis_backup.sh');
  const drill = read('scripts/vps/restore_drill.sh');
  assert.match(postgres, /pg_restore --list/);
  assert.match(postgres, /sha256sum/);
  assert.match(redis, /redis-check-rdb/);
  assert.match(redis, /sha256sum/);
  assert.match(drill, /DRILL_DB=cfanalisis_restore_drill/);
  assert.doesNotMatch(drill, /DRILL_DB=cfanalisis(?:\s|$)/);
});
