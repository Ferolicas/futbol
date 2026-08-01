import {
  stripe,
  PLANS,
  isValidPlan,
  retrieveEmbeddedSubscription,
  stripeInvoiceSubscriptionId,
  stripeSubscriptionAppStatus,
  stripeSubscriptionPeriodEnd,
} from '../../../lib/stripe';
import { pgQuery } from '../../../lib/db';
import {
  activatePaidAccess,
  claimWebhookEvent,
  completeWebhookEvent,
  failWebhookEvent,
  findPaymentOwner,
  getPaymentAccessProfile,
  syncSubscriptionStatus,
  updatePaymentAttempt,
} from '../../../lib/payment-store';
import { reconcileStripeAttempt } from '../../../lib/payment-reconcile';

export const dynamic = 'force-dynamic';

function stringId(value) {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id || null;
}

async function subscriptionOwner(subscription) {
  const metadata = subscription?.metadata || {};
  return findPaymentOwner({
    attemptId: metadata.checkoutAttemptId,
    userId: metadata.userId,
    provider: 'stripe',
    customerId: stringId(subscription?.customer),
    subscriptionId: subscription?.id,
  });
}

async function retrieveSubscriptionFromInvoice(invoice) {
  const subscriptionId = stripeInvoiceSubscriptionId(invoice);
  if (!subscriptionId) return null;
  return (await retrieveEmbeddedSubscription(subscriptionId)).subscription;
}

async function handleSubscription(subscription) {
  const owner = await subscriptionOwner(subscription);
  if (!owner) throw new Error(`Stripe owner not found for subscription ${subscription.id}`);
  const plan = subscription.metadata?.plan || owner.plan;
  if (!isValidPlan(plan)) throw new Error(`Invalid Stripe plan for subscription ${subscription.id}`);

  if (owner.attempt && owner.attempt.status !== 'succeeded') {
    return reconcileStripeAttempt(owner.attempt);
  }

  const appStatus = stripeSubscriptionAppStatus(subscription);
  const periodEnd = stripeSubscriptionPeriodEnd(subscription);
  if (appStatus === 'active') {
    // Los eventos de suscripcion no prueban por si solos un nuevo cobro y no
    // deben mover last_payment_at. La factura pagada es la unica que registra
    // dinero; aqui solo sincronizamos estado y vigencia.
    return syncSubscriptionStatus({
      userId: owner.userId,
      provider: 'stripe',
      status: 'active',
      customerId: stringId(subscription.customer),
      subscriptionId: subscription.id,
      periodEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      providerStatus: subscription.status,
    });
  }
  const currentProfile = appStatus === 'cancelled'
    ? await getPaymentAccessProfile(owner.userId)
    : null;
  const keepPaidPeriod = appStatus === 'cancelled'
    && currentProfile?.cancel_at_period_end === true
    && !!periodEnd
    && new Date(periodEnd).getTime() > Date.now();
  return syncSubscriptionStatus({
    userId: owner.userId,
    provider: 'stripe',
    status: appStatus,
    customerId: stringId(subscription.customer),
    subscriptionId: subscription.id,
    periodEnd,
    cancelAtPeriodEnd: subscription.cancel_at_period_end || keepPaidPeriod,
    providerStatus: subscription.status,
  });
}

async function handlePaidInvoice(invoice) {
  const subscription = await retrieveSubscriptionFromInvoice(invoice);
  if (!subscription) return;
  const owner = await subscriptionOwner(subscription);
  if (!owner) throw new Error(`Stripe owner not found for invoice ${invoice.id}`);
  const plan = subscription.metadata?.plan || owner.plan;
  if (!isValidPlan(plan)) throw new Error(`Invalid Stripe plan for invoice ${invoice.id}`);

  await activatePaidAccess({
    attemptId: owner.attempt?.id || null,
    userId: owner.userId,
    plan,
    provider: 'stripe',
    customerId: stringId(subscription.customer),
    subscriptionId: subscription.id,
    paymentId: invoice.id,
    amount: invoice.amount_paid,
    currency: invoice.currency,
    periodEnd: stripeSubscriptionPeriodEnd(subscription),
    providerStatus: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });
}

async function handleFailedInvoice(invoice, eventType) {
  const subscription = await retrieveSubscriptionFromInvoice(invoice);
  if (!subscription) return;
  const owner = await subscriptionOwner(subscription);
  if (!owner) throw new Error(`Stripe owner not found for invoice ${invoice.id}`);
  const appStatus = stripeSubscriptionAppStatus(subscription);

  // En la primera factura, incomplete significa que el comprador aun puede
  // completar autenticacion; no se le marca past_due prematuramente.
  if (appStatus === 'pending' && owner.attempt) {
    await updatePaymentAttempt(owner.attempt.id, {
      status: 'processing',
      last_provider_status: eventType,
      last_reconciled_at: new Date().toISOString(),
      error_code: eventType,
    });
    return;
  }

  await syncSubscriptionStatus({
    userId: owner.userId,
    provider: 'stripe',
    // Una accion requerida o una factura anulada no debe cortar acceso si
    // Stripe aun considera vigente la suscripcion (por ejemplo, una factura
    // de renovacion que sigue dentro del periodo pagado).
    status: appStatus === 'active' ? 'active' : 'past_due',
    customerId: stringId(subscription.customer),
    subscriptionId: subscription.id,
    periodEnd: stripeSubscriptionPeriodEnd(subscription),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    providerStatus: eventType,
  });
}

async function handleLegacyPaymentIntent(paymentIntent) {
  // Compatibilidad de la ventana de despliegue con PaymentIntents creados por
  // la version anterior. Estos intentos se cancelaran al publicar el nuevo flujo,
  // pero si uno se confirma en la carrera, nunca dejamos a alguien cobrado sin acceso.
  if (paymentIntent.metadata?.checkoutAttemptId) return;
  const { userId, plan } = paymentIntent.metadata || {};
  if (!userId || !isValidPlan(plan) || !paymentIntent.customer) return;
  const owner = await findPaymentOwner({
    userId,
    provider: 'stripe',
    customerId: stringId(paymentIntent.customer),
  });
  if (!owner) throw new Error(`Legacy Stripe owner not found for ${paymentIntent.id}`);
  const periodEnd = new Date(Date.now() + PLANS[plan].intervalSeconds * 1000).toISOString();
  await activatePaidAccess({
    userId: owner.userId,
    plan,
    provider: 'stripe',
    customerId: stringId(paymentIntent.customer),
    paymentId: paymentIntent.id,
    amount: paymentIntent.amount_received,
    currency: paymentIntent.currency,
    periodEnd,
    providerStatus: paymentIntent.status,
  });
  await pgQuery(
    `UPDATE public.user_profiles SET subscription_setup_status = 'failed',
       subscription_setup_error = 'legacy_payment_requires_manual_migration', updated_at = NOW()
     WHERE id = $1`,
    [owner.userId],
  );
}

export async function POST(request) {
  if (!stripe) return Response.json({ error: 'Stripe not configured' }, { status: 500 });

  const body = await request.text();
  const signature = request.headers.get('stripe-signature');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !signature) {
    return Response.json({ error: 'Webhook signature required' }, { status: 400 });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, secret);
  } catch (error) {
    console.error('[stripe:webhook:signature]', error.message);
    return Response.json({ error: 'Webhook signature failed' }, { status: 400 });
  }

  const resourceId = event.data?.object?.id || null;
  const claim = await claimWebhookEvent({
    provider: 'stripe',
    eventId: event.id,
    eventType: event.type,
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
    switch (event.type) {
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        await handlePaidInvoice(event.data.object);
        break;
      case 'invoice.payment_failed':
      case 'invoice.payment_action_required':
      case 'invoice.finalization_failed':
      case 'invoice.marked_uncollectible':
      case 'invoice.voided':
        await handleFailedInvoice(event.data.object, event.type);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        // Stripe no garantiza orden de entrega. Releemos el recurso actual para
        // que un evento atrasado nunca pueda regresar estado o vencimiento.
        const current = await retrieveEmbeddedSubscription(event.data.object.id);
        await handleSubscription(current.subscription);
        break;
      }
      case 'payment_intent.succeeded':
        await handleLegacyPaymentIntent(event.data.object);
        break;
      default:
        break;
    }
    await completeWebhookEvent('stripe', event.id);
    return Response.json({ received: true });
  } catch (error) {
    await failWebhookEvent('stripe', event.id, error).catch(() => {});
    console.error('[stripe:webhook]', event.id, event.type, error.message);
    return Response.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
}
