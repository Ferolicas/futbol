const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('mobile stores hardened session and MFA cookies only on this device', () => {
  const session = read('apps/cfanalisis-mobile/src/lib/session.ts');
  assert.match(session, /__Host-cf_session/);
  assert.match(session, /__Host-cf_mfa/);
  assert.match(session, /WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
  assert.match(session, /clearAuthTokens/);
});

test('mobile registration waits for email verification and supports MFA', () => {
  const auth = read('apps/cfanalisis-mobile/src/lib/auth-context.tsx');
  const signup = read('apps/cfanalisis-mobile/src/app/(auth)/sign-up.tsx');
  assert.match(auth, /verificationRequired/);
  assert.match(auth, /api\/auth\/verify-email/);
  assert.match(auth, /api\/auth\/mfa\/verify/);
  assert.match(signup, /router\.replace\('\/verify-email'\)/);
  assert.equal(fs.existsSync(path.join(root, 'apps/cfanalisis-mobile/src/app/(auth)/mfa.tsx')), true);
  assert.equal(fs.existsSync(path.join(root, 'apps/cfanalisis-mobile/src/app/(auth)/reset-password.tsx')), true);
});

test('mobile password change requests an email link and never submits a new password from the session', () => {
  const modal = read('apps/cfanalisis-mobile/src/components/account/ChangePasswordModal.tsx');
  assert.match(modal, /api\.post\('\/api\/auth\/change-password'\)/);
  assert.doesNotMatch(modal, /newPassword|confirmPassword|TextInput/);
  assert.match(modal, /enlace seguro/i);
});

test('mobile legal screen exposes canonical documents and consent withdrawal', () => {
  const legal = read('apps/cfanalisis-mobile/src/app/(app)/legal.tsx');
  const constants = read('apps/cfanalisis-mobile/src/lib/legal.ts');
  assert.match(legal, /api\/legal\/marketing/);
  assert.match(legal, /source: 'mobile'/);
  assert.match(constants, /https:\/\/cfanalisis\.com\/terminos/);
  assert.match(constants, /https:\/\/cfanalisis\.com\/privacidad/);
  assert.match(constants, /https:\/\/cfanalisis\.com\/cookies/);
});

test('mobile release disables backups, cleartext and arbitrary iOS transport', () => {
  const config = JSON.parse(read('apps/cfanalisis-mobile/app.json'));
  const plugin = read('apps/cfanalisis-mobile/plugins/with-security.js');
  assert.equal(config.expo.android.allowBackup, false);
  assert.equal(config.expo.ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads, false);
  assert.equal(config.expo.ios.infoPlist.UIFileSharingEnabled, false);
  assert.match(plugin, /android:usesCleartextTraffic.*false/);
  assert.match(plugin, /android:allowBackup.*false/);
});

test('transactional emails keep tokens in fragments and offer app deep links', () => {
  const email = read('lib/email.js');
  assert.match(email, /cfanalisis:\/\/\/reset-password#token=/);
  assert.match(email, /cfanalisis:\/\/\/\$\{safePath\.replace/);
  assert.match(email, /verifyAppUrl.*#token=/s);
  assert.doesNotMatch(email, /reset-password\?token=/);
  assert.doesNotMatch(email, /verify-email\?token=/);
});
