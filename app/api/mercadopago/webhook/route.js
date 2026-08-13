import { createHash } from 'crypto';
import {
  getAuthorizedPayment,
  getMercadoPagoOrder,
  getMercadoPagoPayment,
  getPreapproval,
  isValidPlan,
  mercadoPagoPaymentPreapprovalId,
  mercadoPagoPeriodEnd,
  mpStatusToApp,
  verifyWebhookSignature,
} from '../../../../lib/mercadopago';
import {
  activatePaidAccess,
  claimWebhookEvent,
  completeWebhookEvent,
  failWebhookEvent,
  findPaymentOwner,
  getPaymentAttemptByResource,
  getPaymentAccessProfile,
  syncSubscriptionStatus,
  updatePaymentAttempt,
} from '../../../../lib/payment-store';

export const dynamic = 'force-dynamic';

function stableEventId(request, body, type, resourceId) {
  if (body?.id && String(body.id) !== String(resourceId)) return String(body.id);
  if (body?.date_created || body?.action) {
    return createHash('sha256')
      .update(`${type}:${resourceId}:${body.date_created || ''}:${body.action || ''}:${body.id || ''}`)
      .digest('hex');
  }
  const requestId = request.headers.get('x-request-id');
  if (requestId) return requestId;
  return createHash('sha256')
    .update(`${type}:${resourceId}:${body?.action || body?.date_created || JSON.stringify(body || {})}`)
    .digest('hex');
}

async function ownerForMp({ attemptId = null, userId = null, resourceId = null }) {
  return findPaymentOwner({
    attemptId,
    userId,
    provider: 'mercadopago',
    subscriptionId: resourceId,
    customerId: resourceId,
  });
}

async function handlePreapproval(id) {
  const preapproval = await getPreapproval(id);
  if (!preapproval) throw new Error(`Mercado Pago preapproval not found: ${id}`);
  const attempt = await getPaymentAttemptByResource('mercadopago', preapproval.id);
  const owner = await ownerForMp({
    attemptId: attempt?.id,
    userId: preapproval.external_reference,
    resourceId: preapproval.id,
  });
  if (!owner) throw new Error(`Mercado Pago owner not found for preapproval ${id}`);

  // authorized solo confirma el vinculo de la suscripcion. El acceso se activa
  // con subscription_authorized_payment cuando el cobro figure approved.
  if (preapproval.status === 'authorized') {
    if (owner.attempt && owner.attempt.status !== 'succeeded') {
      await updatePaymentAttempt(owner.attempt.id, {
        status: 'processing',
        last_provider_status: preapproval.status,
        last_reconciled_at: new Date().toISOString(),
      });
    }
    return;
  }

  const appStatus = mpStatusToApp(preapproval.status);
  if (['cancelled', 'past_due'].includes(appStatus)) {
    const profile = await getPaymentAccessProfile(owner.userId);
    const periodEnd = preapproval.next_payment_date
      || profile?.subscription_current_period_end
      || profile?.plan_expires_at
      || null;
    const paidPeriodRemaining = periodEnd && new Date(periodEnd).getTime() > Date.now();
    const hasConfirmedPaidPeriod = owner.attempt?.status === 'succeeded'
      || profile?.subscription_status === 'active'
      || (profile?.subscription_status === 'cancelled' && profile?.cancel_at_period_end === true);
    await syncSubscriptionStatus({
      userId: owner.userId,
      provider: 'mercadopago',
      status: appStatus,
      subscriptionId: preapproval.id,
      periodEnd,
      cancelAtPeriodEnd: appStatus === 'cancelled'
        && !!paidPeriodRemaining
        && hasConfirmedPaidPeriod,
      providerStatus: preapproval.status,
    });
  }
  if (owner.attempt && owner.attempt.status !== 'succeeded') {
    await updatePaymentAttempt(owner.attempt.id, {
      status: appStatus === 'cancelled' ? 'cancelled' : appStatus === 'past_due' ? 'failed' : 'processing',
      last_provider_status: preapproval.status,
      last_reconciled_at: new Date().toISOString(),
    });
  }
}

async function handleRecurringPayment(payment, preapprovalId, knownPreapproval = null) {
  const preapproval = knownPreapproval || await getPreapproval(preapprovalId);
  if (!preapproval) throw new Error(`Mercado Pago preapproval not found: ${preapprovalId}`);
  const expectedUserId = preapproval.external_reference || payment.external_reference;
  if (
    preapproval.external_reference
    && payment.external_reference
    && String(preapproval.external_reference) !== String(payment.external_reference)
  ) {
    throw new Error(`Mercado Pago ownership mismatch for recurring payment ${payment.id}`);
  }

  const attempt = await getPaymentAttemptByResource('mercadopago', preapproval.id);
  const owner = await ownerForMp({
    attemptId: attempt?.id,
    userId: expectedUserId,
    resourceId: preapproval.id,
  });
  if (!owner) throw new Error(`Mercado Pago owner not found for recurring payment ${payment.id}`);
  const plan = owner.attempt?.plan || owner.plan;
  if (!isValidPlan(plan)) throw new Error(`Invalid plan for recurring payment ${payment.id}`);

  if (payment.status === 'approved') {
    const parsedPaidAt = new Date(payment.date_approved || payment.date_created || Date.now());
    const paidAt = Number.isFinite(parsedPaidAt.getTime()) ? parsedPaidAt : new Date();
    const nextPaymentAt = preapproval.next_payment_date
      ? new Date(preapproval.next_payment_date)
      : null;
    const periodEnd = nextPaymentAt
      && Number.isFinite(nextPaymentAt.getTime())
      && nextPaymentAt.getTime() > paidAt.getTime()
      ? nextPaymentAt.toISOString()
      : mercadoPagoPeriodEnd(plan, paidAt);
    await activatePaidAccess({
      attemptId: owner.attempt?.id || null,
      userId: owner.userId,
      plan,
      provider: 'mercadopago',
      subscriptionId: preapproval.id,
      paymentId: String(payment.id),
      amount: Math.round(Number(payment.transaction_amount || 0)),
      currency: payment.currency_id || 'COP',
      periodEnd,
      providerStatus: payment.status,
      cancelAtPeriodEnd: mpStatusToApp(preapproval.status) === 'cancelled',
    });
    return;
  }

  const terminal = ['rejected', 'cancelled', 'canceled', 'refunded', 'charged_back'].includes(payment.status);
  if (!terminal) {
    if (owner.attempt && owner.attempt.status !== 'succeeded') {
      await updatePaymentAttempt(owner.attempt.id, {
        status: 'processing',
        provider_payment_id: String(payment.id),
        last_provider_status: payment.status,
        last_reconciled_at: new Date().toISOString(),
      });
    }
    return;
  }

  const reversed = ['refunded', 'charged_back'].includes(payment.status);
  if (owner.attempt?.status === 'succeeded' || !owner.attempt) {
    const profile = await getPaymentAccessProfile(owner.userId);
    const periodEnd = profile?.subscription_current_period_end || profile?.plan_expires_at || null;
    const paidPeriodRemaining = periodEnd && new Date(periodEnd).getTime() > Date.now();
    await syncSubscriptionStatus({
      userId: owner.userId,
      provider: 'mercadopago',
      status: reversed ? 'cancelled' : paidPeriodRemaining ? 'active' : 'past_due',
      subscriptionId: preapproval.id,
      periodEnd,
      cancelAtPeriodEnd: !reversed && profile?.cancel_at_period_end === true,
      providerStatus: payment.status,
    });
  }
  if (owner.attempt) {
    // Los rechazos de un cobro recurrente pueden ser reintentados por MP. Una
    // devolucion/contracargo si es terminal y libera una compra futura.
    await updatePaymentAttempt(owner.attempt.id, {
      status: reversed ? 'failed' : 'processing',
      provider_payment_id: String(payment.id),
      last_provider_status: payment.status,
      error_code: payment.status_detail || payment.status,
      last_reconciled_at: new Date().toISOString(),
    });
  }
}

async function handleAuthorizedPayment(id) {
  const invoice = await getAuthorizedPayment(id);
  if (!invoice) throw new Error(`Mercado Pago authorized payment not found: ${id}`);
  const preapproval = await getPreapproval(invoice.preapproval_id);
  if (!preapproval) throw new Error(`Mercado Pago preapproval not found: ${invoice.preapproval_id}`);
  const attempt = await getPaymentAttemptByResource('mercadopago', preapproval.id);
  const owner = await ownerForMp({
    attemptId: attempt?.id,
    userId: preapproval.external_reference || invoice.external_reference,
    resourceId: preapproval.id,
  });
  if (!owner) throw new Error(`Mercado Pago owner not found for authorized payment ${id}`);
  const paymentStatus = invoice.payment?.status || invoice.summarized || invoice.status;

  if (invoice.payment?.id) {
    const payment = await getMercadoPagoPayment(invoice.payment.id);
    if (!payment) throw new Error(`Mercado Pago payment not found: ${invoice.payment.id}`);
    return handleRecurringPayment(payment, preapproval.id, preapproval);
  }
  if (owner.attempt && owner.attempt.status !== 'succeeded') {
    await updatePaymentAttempt(owner.attempt.id, {
      status: 'processing',
      last_provider_status: paymentStatus,
      last_reconciled_at: new Date().toISOString(),
    });
  }
}

async function handleOneTimePayment(id) {
  const payment = await getMercadoPagoPayment(id);
  if (!payment) throw new Error(`Mercado Pago payment not found: ${id}`);
  const recurringPreapprovalId = mercadoPagoPaymentPreapprovalId(payment);
  if (recurringPreapprovalId) {
    return handleRecurringPayment(payment, recurringPreapprovalId);
  }
  if (payment.operation_type === 'recurring_payment') {
    throw new Error(`Recurring Mercado Pago payment ${id} has no preapproval reference`);
  }
  const attempt = await getPaymentAttemptByResource('mercadopago', String(payment.id));
  const owner = await ownerForMp({
    attemptId: attempt?.id,
    userId: payment.external_reference,
    resourceId: String(payment.id),
  });
  if (!owner) throw new Error(`Mercado Pago owner not found for payment ${id}`);
  const plan = owner.attempt?.plan || owner.plan;
  if (!isValidPlan(plan)) throw new Error(`Invalid plan for payment ${id}`);

  if (payment.status === 'approved') {
    await activatePaidAccess({
      attemptId: owner.attempt?.id || null,
      userId: owner.userId,
      plan,
      provider: 'mercadopago',
      subscriptionId: String(payment.id),
      paymentId: String(payment.id),
      amount: Math.round(Number(payment.transaction_amount || 0)),
      currency: payment.currency_id || 'COP',
      periodEnd: mercadoPagoPeriodEnd(plan, new Date(payment.date_approved || payment.date_created || Date.now())),
      providerStatus: payment.status,
    });
    return;
  }
  if (owner.attempt) {
    const terminal = ['rejected', 'cancelled', 'refunded', 'charged_back'].includes(payment.status);
    if (owner.attempt.status === 'succeeded' && ['refunded', 'charged_back'].includes(payment.status)) {
      await syncSubscriptionStatus({
        userId: owner.userId,
        provider: 'mercadopago',
        status: 'cancelled',
        subscriptionId: String(payment.id),
        periodEnd: null,
        cancelAtPeriodEnd: false,
        providerStatus: payment.status,
      });
    }
    await updatePaymentAttempt(owner.attempt.id, {
      status: terminal
        ? (owner.attempt.status === 'succeeded' ? 'cancelled' : 'failed')
        : 'processing',
      provider_payment_id: String(payment.id),
      last_provider_status: payment.status,
      error_code: terminal ? (payment.status_detail || payment.status) : null,
      last_reconciled_at: new Date().toISOString(),
    });
  }
}

async function handleOrder(id) {
  const order = await getMercadoPagoOrder(id);
  if (!order) throw new Error(`Mercado Pago order not found: ${id}`);
  const paymentId = order.transactions?.payments?.[0]?.id || order.payments?.[0]?.id;
  if (paymentId) return handleOneTimePayment(paymentId);
  if (!['cancelled', 'expired'].includes(order.status)) return;
  const attempt = await getPaymentAttemptByResource('mercadopago', String(order.id));
  if (attempt && attempt.status !== 'succeeded') {
    await updatePaymentAttempt(attempt.id, {
      status: 'failed',
      last_provider_status: order.status,
      error_code: order.status,
      last_reconciled_at: new Date().toISOString(),
    });
  }
}

export async function POST(request) {
  const url = new URL(request.url);
  const signedDataId = url.searchParams.get('data.id');
  const queryId = signedDataId || url.searchParams.get('id');
  let type = url.searchParams.get('type') || url.searchParams.get('topic');
  const body = await request.json().catch(() => null);
  type = body?.type || body?.topic || type;
  const resourceId = queryId || body?.data?.id || body?.id;
  if (!resourceId || !type) return Response.json({ received: true, ignored: true });

  // La firma de MP usa exclusivamente data.id de la URL. Si no vino en query,
  // el par id se omite del manifest; el id del body NO debe sustituirlo.
  const signatureValid = verifyWebhookSignature(request, signedDataId);
  if (signatureValid !== true && process.env.MP_ENV === 'live') {
    console.warn('[mp:webhook] firma invalida', { resourceId, type });
    return Response.json({ error: 'Webhook signature failed' }, { status: 401 });
  }

  const eventId = stableEventId(request, body, type, resourceId);
  const claim = await claimWebhookEvent({
    provider: 'mercadopago',
    eventId,
    eventType: type,
    resourceId,
  });
  if (claim === 'completed') return Response.json({ received: true, deduped: true });
  if (claim !== 'claimed') {
    return Response.json(
      { error: 'Webhook already processing; retry later' },
      { status: 503, headers: { 'Retry-After': '10' } },
    );
  }

  try {
    if (/authorized_payment/i.test(type)) {
      await handleAuthorizedPayment(resourceId);
    } else if (/preapproval_plan/i.test(type)) {
      // La app crea suscripciones sin plan remoto; los cambios del catalogo de
      // planes de MP no representan ni un cobro ni un derecho de acceso.
    } else if (/preapproval/i.test(type)) {
      await handlePreapproval(resourceId);
    } else if (/payment/i.test(type)) {
      await handleOneTimePayment(resourceId);
    } else if (/order/i.test(type)) {
      await handleOrder(resourceId);
    }
    await completeWebhookEvent('mercadopago', eventId);
    return Response.json({ received: true });
  } catch (error) {
    await failWebhookEvent('mercadopago', eventId, error).catch(() => {});
    console.error('[mp:webhook]', eventId, type, error.message);
    // Mercado Pago reintenta al no recibir 200/201. No convertimos 429/5xx/404
    // transitorios de su API en un falso "notfound" exitoso.
    return Response.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
}
