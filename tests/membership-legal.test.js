const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('paid access requires a real future period and inactive behaves as Free', async () => {
  const { hasActiveEntitlement } = await import('../lib/entitlements.js');
  const { inactiveMembershipState } = await import('../lib/subscription-policy.js');
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(hasActiveEntitlement({ role: 'user', subscription_status: 'active' }), false);
  assert.equal(hasActiveEntitlement({ role: 'user', subscription_status: 'active', plan_expires_at: past }), false);
  assert.equal(hasActiveEntitlement({ role: 'user', subscription_status: 'active', plan_expires_at: future }), true);
  assert.equal(hasActiveEntitlement({ role: 'user', subscription_status: 'inactive', plan_expires_at: future }), false);
  assert.equal(inactiveMembershipState().plan, 'free');
});

test('a provider retry only reactivates on a new or newly-approved payment', async () => {
  const { shouldApplyConfirmedPayment } = await import('../lib/subscription-policy.js');
  assert.equal(shouldApplyConfirmedPayment({ paymentId: 'pay_2', previousPaymentId: 'pay_1', previousProviderStatus: 'paid' }), true);
  assert.equal(shouldApplyConfirmedPayment({ paymentId: 'pay_1', previousPaymentId: 'pay_1', previousProviderStatus: 'rejected' }), true);
  assert.equal(shouldApplyConfirmedPayment({ paymentId: 'pay_1', previousPaymentId: 'pay_1', previousProviderStatus: 'paid' }), false);
  assert.equal(shouldApplyConfirmedPayment({ paymentId: null }), false);
});

test('display names are normalized, bounded and reject abuse or impersonation', async () => {
  const { validateDisplayName } = await import('../lib/user-profile-validation.js');
  assert.deepEqual(validateDisplayName('  María   José  '), { success: true, name: 'María José', error: null });
  assert.equal(validateDisplayName('a'.repeat(61)).success, false);
  assert.equal(validateDisplayName('uno dos tres cuatro cinco seis siete').success, false);
  assert.equal(validateDisplayName('puto si lees esto').success, false);
  assert.equal(validateDisplayName('Soporte').success, false);
});

test('registration and checkout fail closed on legal acceptance', () => {
  const root = path.join(__dirname, '..');
  const register = fs.readFileSync(path.join(root, 'app/api/register/route.js'), 'utf8');
  const auth = fs.readFileSync(path.join(root, 'lib/auth-pg.js'), 'utf8');
  const gate = fs.readFileSync(path.join(root, 'components/LegalAcceptanceGate.js'), 'utf8');
  const stripe = fs.readFileSync(path.join(root, 'app/api/checkout/route.js'), 'utf8');
  const mp = fs.readFileSync(path.join(root, 'app/api/mercadopago/subscribe/route.js'), 'utf8');
  assert.match(register, /acceptAll !== true/);
  assert.match(auth, /INSERT INTO public\.legal_acceptances/);
  assert.match(auth, /La cuenta, el perfil y la prueba legal nacen en la misma transacción/);
  assert.match(stripe, /currentLegalAcceptance/);
  assert.match(mp, /currentLegalAcceptance/);
  assert.match(gate, /\['\/terminos', '\/privacidad', '\/cookies'\]/);
});

test('marketing campaigns use consent, recheck it and carry unsubscribe controls', () => {
  const root = path.join(__dirname, '..');
  const campaign = fs.readFileSync(path.join(root, 'lib/marketing-campaigns.js'), 'utf8');
  const email = fs.readFileSync(path.join(root, 'lib/email.js'), 'utf8');
  assert.match(campaign, /latest\.action = 'consent'/);
  assert.match(campaign, /stillConsented/);
  assert.match(email, /List-Unsubscribe/);
  assert.match(email, /info@cfanalisis\.com/);
});

test('landing video is served with the real video MIME type', () => {
  const config = fs.readFileSync(path.join(__dirname, '..', 'next.config.mjs'), 'utf8');
  assert.match(config, /logo-metalizado-fast\.webm/);
  assert.match(config, /value: 'video\/webm'/);
});
