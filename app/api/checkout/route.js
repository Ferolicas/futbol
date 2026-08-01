import { z } from 'zod';
import {
  createEmbeddedSubscription,
  isValidPlan,
  retrieveEmbeddedSubscription,
  stripeSubscriptionPeriodEnd,
} from '../../../lib/stripe';
import { createSupabaseServerClient } from '../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../lib/supabase';
import { jsonError } from '../../../lib/api-error';
import { redisRateLimit } from '../../../lib/ratelimit-redis';
import { resolvePaymentGeo } from '../../../lib/payment-geo';
import {
  activatePaidAccess,
  reservePaymentAttempt,
  updatePaymentAttempt,
} from '../../../lib/payment-store';
import { hasActiveEntitlement } from '../../../lib/entitlements';

export const dynamic = 'force-dynamic';

const checkoutSchema = z.object({
  plan: z.string(),
  attemptId: z.string().uuid(),
  country: z.string().length(2).optional().nullable(),
  currency: z.string().length(3).optional().nullable(),
});

function publicCheckoutError(error) {
  if (error.code === 'PAYMENT_IN_PROGRESS') {
    return Response.json({
      error: 'Ya tienes un pago abierto. Cierralo antes de cambiar de plan.',
      code: error.code,
      attemptId: error.attemptId,
      plan: error.existingPlan,
    }, { status: 409 });
  }
  if (error.code === 'INVALID_ATTEMPT' || error.code === 'ATTEMPT_OWNERSHIP') {
    return Response.json({ error: 'Intento de pago invalido.', code: error.code }, { status: 400 });
  }
  return null;
}

export async function POST(request) {
  let activeAttemptId = null;
  try {
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const parsed = checkoutSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || !isValidPlan(parsed.data?.plan)) {
      return Response.json({ error: 'Datos de checkout invalidos' }, { status: 400 });
    }
    const { plan, attemptId, country, currency } = parsed.data;

    const limit = await redisRateLimit('stripe-checkout', user.id, 8, 5 * 60);
    if (!limit.success) {
      return Response.json({ error: 'Demasiados intentos. Espera unos minutos.' }, { status: 429 });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('user_profiles')
      .select('id, name, email, role, plan, subscription_status, stripe_customer_id, plan_expires_at, subscription_current_period_end, cancel_at_period_end')
      .eq('id', user.id)
      .single();
    if (profileError || !profile) return Response.json({ error: 'User not found' }, { status: 404 });
    if (hasActiveEntitlement(profile)) {
      return Response.json({ error: 'Tu cuenta ya tiene un plan activo.', code: 'ALREADY_ACTIVE' }, { status: 409 });
    }

    const geo = await resolvePaymentGeo(request, { country, currency });
    if (geo.country === 'CO') {
      return Response.json({ error: 'En Colombia el pago se procesa con Mercado Pago.', code: 'USE_MERCADOPAGO' }, { status: 409 });
    }

    const reserved = await reservePaymentAttempt({
      id: attemptId,
      userId: profile.id,
      provider: 'stripe',
      kind: 'subscription',
      plan,
      currency: geo.currency,
    });
    activeAttemptId = reserved.attempt.id;
    let result;

    if (reserved.attempt.provider_resource_id) {
      const reused = await retrieveEmbeddedSubscription(reserved.attempt.provider_resource_id);
      const subscription = reused.subscription;
      if (subscription.metadata?.userId !== profile.id || subscription.metadata?.plan !== plan) {
        throw new Error('Stripe subscription ownership mismatch');
      }
      if (['active', 'trialing'].includes(subscription.status)) {
        await activatePaidAccess({
          attemptId: reserved.attempt.id,
          userId: profile.id,
          plan,
          provider: 'stripe',
          customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id,
          subscriptionId: subscription.id,
          amount: reserved.attempt.amount,
          currency: reserved.attempt.currency,
          periodEnd: stripeSubscriptionPeriodEnd(subscription),
          providerStatus: subscription.status,
        });
        return Response.json({ active: true, attemptId: reserved.attempt.id });
      }
      if (['canceled', 'incomplete_expired'].includes(subscription.status)) {
        await updatePaymentAttempt(reserved.attempt.id, {
          status: subscription.status === 'canceled' ? 'cancelled' : 'expired',
          last_provider_status: subscription.status,
          completed_at: new Date().toISOString(),
        });
        return Response.json({ error: 'El intento vencio. Vuelve a seleccionar el plan.', code: 'ATTEMPT_EXPIRED' }, { status: 409 });
      }
      result = {
        clientSecret: reused.clientSecret,
        customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id,
        subscriptionId: subscription.id,
        status: subscription.status,
        amount: reserved.attempt.amount,
        currency: reserved.attempt.currency,
        plan,
      };
    } else {
      result = await createEmbeddedSubscription({
        plan,
        userId: profile.id,
        email: profile.email,
        name: profile.name,
        currency: geo.currency,
        storedCustomerId: profile.stripe_customer_id,
        attemptId: reserved.attempt.id,
      });
    }

    if (!result.clientSecret) throw new Error('Stripe checkout unavailable');
    const persisted = await updatePaymentAttempt(reserved.attempt.id, {
      status: 'requires_payment',
      amount: result.amount,
      currency: result.currency,
      provider_customer_id: result.customerId,
      provider_resource_id: result.subscriptionId,
      last_provider_status: result.status,
      error_code: null,
      error_message: null,
    });
    if (!persisted) throw new Error('Payment attempt persistence failed');
    if (persisted.status === 'succeeded') {
      return Response.json({ active: true, attemptId: persisted.id });
    }

    return Response.json({
      clientSecret: result.clientSecret,
      attemptId: reserved.attempt.id,
      plan: result.plan,
      amount: result.amount,
      currency: result.currency || 'eur',
    });
  } catch (error) {
    if (activeAttemptId) {
      const transient = error?.type === 'StripeConnectionError'
        || error?.code === 'ETIMEDOUT'
        || Number(error?.statusCode || 0) >= 500;
      await updatePaymentAttempt(activeAttemptId, {
        status: transient ? 'processing' : 'failed',
        error_code: error.code || error.type || 'STRIPE_ERROR',
        error_message: String(error.message || error).slice(0, 800),
      }).catch(() => {});
    }
    const publicError = publicCheckoutError(error);
    if (publicError) return publicError;
    console.error('[checkout]', error.message);
    return jsonError(error, { status: 502, publicMessage: 'No pudimos iniciar el pago. Intenta de nuevo.' });
  }
}
