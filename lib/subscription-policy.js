const CONFIRMED_PAYMENT_STATUSES = new Set(['approved', 'paid', 'succeeded']);

export function isConfirmedProviderPayment(status) {
  return CONFIRMED_PAYMENT_STATUSES.has(String(status || '').toLowerCase());
}

/**
 * Un cobro se aplica cuando es nuevo o cuando el mismo recurso acaba de pasar
 * de rechazado/pendiente a pagado. Esto permite recuperar reintentos sin volver
 * a conceder acceso por una factura antigua ya contabilizada.
 */
export function shouldApplyConfirmedPayment({
  paymentId,
  previousPaymentId = null,
  previousProviderStatus = null,
}) {
  if (!paymentId) return false;
  return String(paymentId) !== String(previousPaymentId || '')
    || !isConfirmedProviderPayment(previousProviderStatus);
}

export function hasFuturePaidPeriod(profile, now = Date.now()) {
  const value = profile?.subscription_current_period_end || profile?.plan_expires_at;
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > now;
}

export function inactiveMembershipState() {
  return { subscriptionStatus: 'inactive', plan: 'free' };
}
