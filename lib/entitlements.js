const ACTIVE_STATUSES = new Set(['active', 'trialing']);

function isFuture(value, now = Date.now()) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > now;
}

/**
 * Fuente unica para decidir acceso. Los pagos de una sola vez (PSE/Efecty) y
 * las suscripciones canceladas al final del periodo dejan de dar acceso al
 * vencer plan_expires_at/subscription_current_period_end.
 */
export function hasActiveEntitlement(profile, now = Date.now()) {
  if (!profile) return false;
  if (['admin', 'owner'].includes(profile.role)) return true;

  const periodEnd = profile.subscription_current_period_end || profile.plan_expires_at;
  if (ACTIVE_STATUSES.has(profile.subscription_status)) {
    return !periodEnd || isFuture(periodEnd, now);
  }

  return profile.subscription_status === 'cancelled'
    && profile.cancel_at_period_end === true
    && isFuture(periodEnd, now);
}

export function entitlementPeriodEnd(profile) {
  return profile?.subscription_current_period_end || profile?.plan_expires_at || null;
}
