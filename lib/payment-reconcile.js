import {
  retrieveEmbeddedSubscription,
  stripeSubscriptionAppStatus,
  stripeSubscriptionPeriodEnd,
  isValidPlan,
} from './stripe';
import {
  getPreapproval,
  getMercadoPagoPayment,
  listAuthorizedPayments,
  listMercadoPagoSubscriptionPayments,
  mercadoPagoPeriodEnd,
  mpStatusToApp,
} from './mercadopago';
import {
  activatePaidAccess,
  getPaymentAttemptByResource,
  syncSubscriptionStatus,
  updatePaymentAttempt,
} from './payment-store';
import {
  hasFuturePaidPeriod,
  shouldApplyConfirmedPayment,
} from './subscription-policy';

function stringId(value) {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id || null;
}

function dateOrFallback(value, plan, from = new Date()) {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) && parsed.getTime() > from.getTime()
    ? parsed.toISOString()
    : mercadoPagoPeriodEnd(plan, from);
}

function latestInvoice(subscription) {
  return subscription?.latest_invoice && typeof subscription.latest_invoice === 'object'
    ? subscription.latest_invoice
    : null;
}

export async function reconcileStripeAttempt(attempt) {
  if (!attempt?.provider_resource_id) return attempt;
  const { subscription } = await retrieveEmbeddedSubscription(attempt.provider_resource_id);
  if (subscription.metadata?.userId !== attempt.user_id || subscription.metadata?.plan !== attempt.plan) {
    throw new Error(`Stripe ownership mismatch for ${subscription.id}`);
  }
  const appStatus = stripeSubscriptionAppStatus(subscription);
  const periodEnd = stripeSubscriptionPeriodEnd(subscription);
  const customerId = stringId(subscription.customer);
  const invoice = latestInvoice(subscription);
  const paidInvoice = invoice?.status === 'paid';

  const applyPaidInvoice = paidInvoice && shouldApplyConfirmedPayment({
    paymentId: invoice.id,
    previousPaymentId: attempt.provider_payment_id,
    previousProviderStatus: attempt.last_provider_status,
  });

  if (applyPaidInvoice && ['active', 'cancelled'].includes(appStatus)) {
    await activatePaidAccess({
      attemptId: attempt.id,
      userId: attempt.user_id,
      plan: attempt.plan,
      provider: 'stripe',
      customerId,
      subscriptionId: subscription.id,
      paymentId: invoice.id,
      amount: invoice?.amount_paid ?? attempt.amount,
      currency: invoice?.currency || attempt.currency,
      periodEnd,
      providerStatus: invoice.status,
      cancelAtPeriodEnd: appStatus === 'cancelled' || subscription.cancel_at_period_end,
    });
    if (appStatus === 'cancelled' && subscription.cancel_at_period_end) {
      await syncSubscriptionStatus({
        userId: attempt.user_id,
        provider: 'stripe',
        status: 'cancelled',
        customerId,
        subscriptionId: subscription.id,
        periodEnd,
        cancelAtPeriodEnd: true,
        providerStatus: subscription.status,
      });
    }
    return { ...attempt, status: 'succeeded', last_provider_status: invoice.status };
  }

  if (paidInvoice && appStatus === 'active') return attempt;

  if (appStatus === 'pending') {
    return updatePaymentAttempt(attempt.id, {
      status: subscription.status === 'incomplete' ? 'requires_payment' : 'processing',
      last_provider_status: subscription.status,
      last_reconciled_at: new Date().toISOString(),
    });
  }

  const keepCancelledPaidPeriod = appStatus === 'cancelled'
    && subscription.cancel_at_period_end === true
    && !!periodEnd
    && new Date(periodEnd).getTime() > Date.now()
    && paidInvoice;
  await syncSubscriptionStatus({
    userId: attempt.user_id,
    provider: 'stripe',
    status: keepCancelledPaidPeriod ? 'cancelled' : 'inactive',
    customerId,
    subscriptionId: subscription.id,
    periodEnd,
    cancelAtPeriodEnd: keepCancelledPaidPeriod,
    providerStatus: subscription.status,
  });
  if (attempt.status !== 'succeeded') {
    return updatePaymentAttempt(attempt.id, {
      status: appStatus === 'cancelled' ? 'cancelled' : 'failed',
      last_provider_status: subscription.status,
      last_reconciled_at: new Date().toISOString(),
      completed_at: appStatus === 'cancelled' ? new Date().toISOString() : null,
    });
  }
  return attempt;
}

export async function reconcileMercadoPagoAttempt(attempt) {
  if (!attempt?.provider_resource_id) return attempt;

  if (attempt.kind === 'one_time') {
    const payment = await getMercadoPagoPayment(attempt.provider_resource_id);
    if (!payment) throw new Error(`Mercado Pago payment not found: ${attempt.provider_resource_id}`);
    if (String(payment.external_reference) !== attempt.user_id) {
      throw new Error(`Mercado Pago ownership mismatch for payment ${payment.id}`);
    }

    if (payment.status === 'approved') {
      await activatePaidAccess({
        attemptId: attempt.id,
        userId: attempt.user_id,
        plan: attempt.plan,
        provider: 'mercadopago',
        subscriptionId: String(payment.id),
        paymentId: String(payment.id),
        amount: Math.round(Number(payment.transaction_amount || attempt.amount || 0)),
        currency: payment.currency_id || attempt.currency || 'COP',
        periodEnd: mercadoPagoPeriodEnd(attempt.plan, new Date(payment.date_approved || payment.date_created || Date.now())),
        providerStatus: payment.status,
      });
      return { ...attempt, status: 'succeeded', last_provider_status: payment.status };
    }

    const terminal = ['rejected', 'cancelled', 'refunded', 'charged_back'].includes(payment.status);
    return updatePaymentAttempt(attempt.id, {
      status: terminal ? 'failed' : 'processing',
      last_provider_status: payment.status,
      provider_payment_id: String(payment.id),
      last_reconciled_at: new Date().toISOString(),
      error_code: terminal ? (payment.status_detail || payment.status) : null,
    });
  }

  const preapproval = await getPreapproval(attempt.provider_resource_id);
  if (!preapproval) throw new Error(`Mercado Pago preapproval not found: ${attempt.provider_resource_id}`);
  if (String(preapproval.external_reference) !== attempt.user_id) {
    throw new Error(`Mercado Pago ownership mismatch for preapproval ${preapproval.id}`);
  }

  // MP puede acreditar el cobro recurrente en Payments API antes de que su
  // buscador de facturas lo indexe. Consultamos ambos caminos y elegimos la
  // confirmacion aprobada mas reciente, siempre ligada al mismo preapproval.
  const [invoiceResult, paymentResult] = await Promise.allSettled([
    listAuthorizedPayments(preapproval.id),
    listMercadoPagoSubscriptionPayments(preapproval.id, attempt.user_id),
  ]);
  if (invoiceResult.status === 'rejected' && paymentResult.status === 'rejected') {
    throw invoiceResult.reason;
  }
  const approved = [];
  if (invoiceResult.status === 'fulfilled') {
    for (const invoice of invoiceResult.value) {
      if (invoice?.payment?.status !== 'approved') continue;
      approved.push({
        paymentId: String(invoice.payment.id || invoice.id),
        amount: Math.round(Number(invoice.transaction_amount || attempt.amount || 0)),
        currency: invoice.currency_id || attempt.currency || 'COP',
        paidAt: invoice.last_modified || invoice.date_created || null,
        providerStatus: invoice.payment.status,
      });
    }
  }
  if (paymentResult.status === 'fulfilled') {
    for (const payment of paymentResult.value) {
      if (payment?.status !== 'approved') continue;
      approved.push({
        paymentId: String(payment.id),
        amount: Math.round(Number(payment.transaction_amount || attempt.amount || 0)),
        currency: payment.currency_id || attempt.currency || 'COP',
        paidAt: payment.date_approved || payment.date_created || null,
        providerStatus: payment.status,
      });
    }
  }
  const paid = approved.sort(
    (a, b) => new Date(b.paidAt || 0).getTime() - new Date(a.paidAt || 0).getTime(),
  )[0];
  if (paid && shouldApplyConfirmedPayment({
    paymentId: paid.paymentId,
    previousPaymentId: attempt.provider_payment_id,
    previousProviderStatus: attempt.last_provider_status,
  })) {
    const parsedPaidAt = paid.paidAt ? new Date(paid.paidAt) : new Date();
    const paidAt = Number.isFinite(parsedPaidAt.getTime()) ? parsedPaidAt : new Date();
    const cancelAtPeriodEnd = mpStatusToApp(preapproval.status) === 'cancelled';
    await activatePaidAccess({
      attemptId: attempt.id,
      userId: attempt.user_id,
      plan: attempt.plan,
      provider: 'mercadopago',
      subscriptionId: preapproval.id,
      paymentId: paid.paymentId,
      amount: paid.amount,
      currency: paid.currency,
      periodEnd: dateOrFallback(preapproval.next_payment_date, attempt.plan, paidAt),
      providerStatus: paid.providerStatus,
      cancelAtPeriodEnd,
    });
    return { ...attempt, status: 'succeeded', last_provider_status: paid.providerStatus };
  }

  if (preapproval.status === 'authorized') {
    if (attempt.status === 'succeeded') return attempt;
    return updatePaymentAttempt(attempt.id, {
      status: 'processing',
      last_provider_status: preapproval.status,
      last_reconciled_at: new Date().toISOString(),
    });
  }

  const appStatus = mpStatusToApp(preapproval.status);
  if (['cancelled', 'inactive'].includes(appStatus)) {
    await syncSubscriptionStatus({
      userId: attempt.user_id,
      provider: 'mercadopago',
      status: appStatus === 'cancelled' ? 'cancelled' : 'inactive',
      subscriptionId: preapproval.id,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      providerStatus: preapproval.status,
    });
  }
  if (attempt.status !== 'succeeded') {
    return updatePaymentAttempt(attempt.id, {
      status: appStatus === 'cancelled' ? 'cancelled' : appStatus === 'inactive' ? 'failed' : 'processing',
      last_provider_status: preapproval.status,
      last_reconciled_at: new Date().toISOString(),
    });
  }
  return attempt;
}

export async function reconcilePaymentAttempt(attempt) {
  if (!attempt) return null;
  if (!isValidPlan(attempt.plan)) throw new Error(`Invalid plan in payment attempt ${attempt.id}`);
  if (attempt.provider === 'stripe') return reconcileStripeAttempt(attempt);
  if (attempt.provider === 'mercadopago') return reconcileMercadoPagoAttempt(attempt);
  throw new Error(`Unsupported payment provider: ${attempt.provider}`);
}

export async function reconcilePaymentProfile(profile) {
  if (!profile?.payment_provider) return null;
  if (profile.payment_provider === 'stripe' && profile.stripe_subscription_id) {
    const { subscription } = await retrieveEmbeddedSubscription(profile.stripe_subscription_id);
    const providerState = stripeSubscriptionAppStatus(subscription);
    const periodEnd = stripeSubscriptionPeriodEnd(subscription);
    const invoice = latestInvoice(subscription);
    const attempt = await getPaymentAttemptByResource('stripe', subscription.id);
    const applyPaidInvoice = invoice?.status === 'paid'
      && attempt
      && shouldApplyConfirmedPayment({
        paymentId: invoice.id,
        previousPaymentId: attempt.provider_payment_id,
        previousProviderStatus: attempt.last_provider_status,
      });
    const explicitPaidCancellation = providerState === 'cancelled'
      && subscription.cancel_at_period_end === true;

    if (applyPaidInvoice) {
      await activatePaidAccess({
        attemptId: attempt.id,
        userId: profile.id,
        plan: attempt.plan,
        provider: 'stripe',
        customerId: stringId(subscription.customer),
        subscriptionId: subscription.id,
        paymentId: invoice.id,
        amount: invoice.amount_paid,
        currency: invoice.currency,
        periodEnd,
        providerStatus: invoice.status,
        cancelAtPeriodEnd: explicitPaidCancellation,
      });
      if (explicitPaidCancellation) {
        await syncSubscriptionStatus({
          userId: profile.id,
          provider: 'stripe',
          status: 'cancelled',
          customerId: stringId(subscription.customer),
          subscriptionId: subscription.id,
          cancelAtPeriodEnd: true,
          providerStatus: subscription.status,
        });
        return 'cancelled';
      }
      return 'active';
    }

    const paidPeriodRemaining = hasFuturePaidPeriod(profile);
    const status = providerState === 'active'
      && invoice?.status === 'paid'
      && paidPeriodRemaining
      && ['active', 'trialing'].includes(profile.subscription_status)
      ? 'active'
      : providerState === 'cancelled'
        && profile.cancel_at_period_end === true
        && paidPeriodRemaining
        ? 'cancelled'
        : 'inactive';
    await syncSubscriptionStatus({
      userId: profile.id,
      provider: 'stripe',
      status,
      customerId: stringId(subscription.customer),
      subscriptionId: subscription.id,
      periodEnd: null,
      cancelAtPeriodEnd: status === 'cancelled',
      providerStatus: subscription.status,
    });
    return status;
  }
  if (profile.payment_provider === 'mercadopago' && profile.mp_preapproval_id) {
    if (/^\d+$/.test(String(profile.mp_preapproval_id))) {
      const payment = await getMercadoPagoPayment(profile.mp_preapproval_id);
      if (!payment) throw new Error(`Mercado Pago payment not found: ${profile.mp_preapproval_id}`);
      if (
        payment.external_reference
        && String(payment.external_reference) !== String(profile.id)
      ) {
        throw new Error(`Mercado Pago ownership mismatch for payment ${payment.id}`);
      }
      const status = payment.status === 'approved'
        && hasFuturePaidPeriod(profile)
        && ['active', 'trialing'].includes(profile.subscription_status)
        ? 'active'
        : 'inactive';
      await syncSubscriptionStatus({
        userId: profile.id,
        provider: 'mercadopago',
        status,
        subscriptionId: String(payment.id),
        periodEnd: profile.subscription_current_period_end || profile.plan_expires_at || null,
        cancelAtPeriodEnd: false,
        providerStatus: payment.status,
      });
      return status;
    }
    const preapproval = await getPreapproval(profile.mp_preapproval_id);
    if (!preapproval) throw new Error(`Mercado Pago preapproval not found: ${profile.mp_preapproval_id}`);
    const payments = await listMercadoPagoSubscriptionPayments(preapproval.id, profile.id);
    const latestPayment = payments.sort(
      (a, b) => new Date(b.date_approved || b.date_created || 0) - new Date(a.date_approved || a.date_created || 0),
    )[0];
    const attempt = await getPaymentAttemptByResource('mercadopago', preapproval.id);
    if (
      preapproval.external_reference
      && String(preapproval.external_reference) !== String(profile.id)
    ) {
      throw new Error(`Mercado Pago ownership mismatch for preapproval ${preapproval.id}`);
    }
    const providerStatus = latestPayment?.status || preapproval.status;
    const applyPaidPayment = latestPayment?.status === 'approved'
      && attempt
      && shouldApplyConfirmedPayment({
        paymentId: String(latestPayment.id),
        previousPaymentId: attempt.provider_payment_id,
        previousProviderStatus: attempt.last_provider_status,
      });
    if (applyPaidPayment) {
      const parsedPaidAt = new Date(latestPayment.date_approved || latestPayment.date_created || Date.now());
      const paidAt = Number.isFinite(parsedPaidAt.getTime()) ? parsedPaidAt : new Date();
      const periodEnd = dateOrFallback(preapproval.next_payment_date, attempt.plan, paidAt);
      const cancelledAtPeriodEnd = mpStatusToApp(preapproval.status) === 'cancelled';
      await activatePaidAccess({
        attemptId: attempt.id,
        userId: profile.id,
        plan: attempt.plan,
        provider: 'mercadopago',
        subscriptionId: preapproval.id,
        paymentId: String(latestPayment.id),
        amount: Math.round(Number(latestPayment.transaction_amount || attempt.amount || 0)),
        currency: latestPayment.currency_id || attempt.currency || 'COP',
        periodEnd,
        providerStatus: latestPayment.status,
        cancelAtPeriodEnd: cancelledAtPeriodEnd,
      });
      if (cancelledAtPeriodEnd) {
        await syncSubscriptionStatus({
          userId: profile.id,
          provider: 'mercadopago',
          status: 'cancelled',
          subscriptionId: preapproval.id,
          cancelAtPeriodEnd: true,
          providerStatus: preapproval.status,
        });
        return 'cancelled';
      }
      return 'active';
    }

    const failedPayment = ['rejected', 'cancelled', 'canceled', 'refunded', 'charged_back']
      .includes(latestPayment?.status);
    const paidPeriodRemaining = hasFuturePaidPeriod(profile);
    const providerState = mpStatusToApp(preapproval.status);
    const status = failedPayment
      ? 'inactive'
      : providerState === 'cancelled'
        && profile.cancel_at_period_end === true
        && paidPeriodRemaining
        ? 'cancelled'
        : preapproval.status === 'authorized'
          && paidPeriodRemaining
          && ['active', 'trialing'].includes(profile.subscription_status)
          ? 'active'
          : 'inactive';
    await syncSubscriptionStatus({
      userId: profile.id,
      provider: 'mercadopago',
      status,
      subscriptionId: preapproval.id,
      periodEnd: null,
      cancelAtPeriodEnd: status === 'cancelled',
      providerStatus,
    });
    return status;
  }
  return null;
}
