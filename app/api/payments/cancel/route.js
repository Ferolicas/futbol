import { getCurrentUser } from '../../../../lib/auth-pg';
import {
  cancelStripeSubscription,
  stripeSubscriptionAppStatus,
  stripeSubscriptionPeriodEnd,
} from '../../../../lib/stripe';
import { cancelPreapproval, getPreapproval } from '../../../../lib/mercadopago';
import { supabaseAdmin } from '../../../../lib/supabase';
import { redisRateLimit } from '../../../../lib/ratelimit-redis';
import { syncSubscriptionStatus } from '../../../../lib/payment-store';

export const dynamic = 'force-dynamic';

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const limit = await redisRateLimit('cancel-subscription', user.id, 3, 10 * 60);
  if (!limit.success) return Response.json({ error: 'Espera unos minutos.' }, { status: 429 });

  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('id, payment_provider, stripe_subscription_id, mp_preapproval_id, plan_expires_at, subscription_current_period_end, cancel_at_period_end')
    .eq('id', user.id)
    .single();
  if (!profile) return Response.json({ error: 'Usuario no encontrado' }, { status: 404 });
  if (profile.cancel_at_period_end) return Response.json({ ok: true, alreadyCancelled: true });

  try {
    if (profile.payment_provider === 'stripe' && profile.stripe_subscription_id) {
      const subscription = await cancelStripeSubscription(profile.stripe_subscription_id, true);
      const periodEnd = stripeSubscriptionPeriodEnd(subscription);
      const providerStatus = stripeSubscriptionAppStatus(subscription);
      await syncSubscriptionStatus({
        userId: user.id,
        provider: 'stripe',
        status: providerStatus === 'active' ? 'active' : 'cancelled',
        customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id,
        subscriptionId: subscription.id,
        periodEnd,
        cancelAtPeriodEnd: !!periodEnd && new Date(periodEnd).getTime() > Date.now(),
        providerStatus: subscription.status,
      });
      return Response.json({ ok: true, accessUntil: periodEnd });
    }

    if (profile.payment_provider === 'mercadopago' && profile.mp_preapproval_id) {
      const before = await getPreapproval(profile.mp_preapproval_id);
      if (!before) return Response.json({ error: 'Suscripcion no encontrada en Mercado Pago.' }, { status: 404 });
      const cancelled = await cancelPreapproval(profile.mp_preapproval_id);
      const periodEnd = before.next_payment_date
        || profile.subscription_current_period_end
        || profile.plan_expires_at;
      await syncSubscriptionStatus({
        userId: user.id,
        provider: 'mercadopago',
        status: 'cancelled',
        subscriptionId: cancelled.id || profile.mp_preapproval_id,
        periodEnd,
        cancelAtPeriodEnd: true,
        providerStatus: cancelled.status || 'cancelled',
      });
      return Response.json({ ok: true, accessUntil: periodEnd });
    }

    return Response.json({
      error: 'Este pago no tiene una renovacion automatica activa.',
      code: 'NO_RECURRING_SUBSCRIPTION',
    }, { status: 409 });
  } catch (error) {
    console.error('[payments:cancel]', user.id, error.message);
    return Response.json({
      error: 'No pudimos cancelar la renovacion. No se cambio tu suscripcion; intenta nuevamente.',
    }, { status: 502 });
  }
}
