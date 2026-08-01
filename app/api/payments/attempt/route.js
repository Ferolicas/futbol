import { getCurrentUser } from '../../../../lib/auth-pg';
import { cancelStripeSubscription } from '../../../../lib/stripe';
import {
  cancelMercadoPagoPayment,
  cancelPreapproval,
} from '../../../../lib/mercadopago';
import {
  getPaymentAttemptForUser,
  updatePaymentAttempt,
} from '../../../../lib/payment-store';
import { reconcilePaymentAttempt } from '../../../../lib/payment-reconcile';
import { redisRateLimit } from '../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

export async function DELETE(request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const limit = await redisRateLimit('cancel-payment-attempt', user.id, 12, 5 * 60);
  if (!limit.success) return Response.json({ error: 'Espera unos minutos.' }, { status: 429 });
  const attemptId = new URL(request.url).searchParams.get('attempt');
  let attempt = await getPaymentAttemptForUser(attemptId, user.id);
  if (!attempt) return Response.json({ ok: true, missing: true });
  if (attempt.status === 'cancelled') return Response.json({ ok: true, alreadyCancelled: true });
  if (attempt.status === 'succeeded') {
    return Response.json({ error: 'Un pago confirmado no se puede descartar.' }, { status: 409 });
  }

  try {
    if (attempt.provider_resource_id) {
      await reconcilePaymentAttempt(attempt);
      attempt = await getPaymentAttemptForUser(attemptId, user.id);
      if (attempt?.status === 'succeeded') {
        return Response.json({
          error: 'El pago ya fue confirmado y tu acceso esta activo.',
          code: 'PAYMENT_ALREADY_APPROVED',
        }, { status: 409 });
      }
    }

    if (attempt.provider_resource_id && attempt.provider === 'stripe') {
      await cancelStripeSubscription(attempt.provider_resource_id, false);
    } else if (
      attempt.provider_resource_id
      && attempt.provider === 'mercadopago'
      && attempt.kind === 'subscription'
    ) {
      await cancelPreapproval(attempt.provider_resource_id);
    } else if (
      attempt.provider_resource_id
      && attempt.provider === 'mercadopago'
      && attempt.kind === 'one_time'
    ) {
      await cancelMercadoPagoPayment(attempt.provider_resource_id, attempt.id);
    }
    if (attempt.provider_resource_id) {
      await reconcilePaymentAttempt(attempt);
      attempt = await getPaymentAttemptForUser(attemptId, user.id);
      if (attempt?.status === 'succeeded') {
        return Response.json({
          error: 'El proveedor confirmo el pago mientras cancelabas. La renovacion quedo cerrada y conservas el periodo pagado.',
          code: 'PAYMENT_ALREADY_APPROVED',
        }, { status: 409 });
      }
    }
    await updatePaymentAttempt(attempt.id, {
      status: 'cancelled',
      completed_at: new Date().toISOString(),
      last_provider_status: 'cancelled_by_user_before_payment',
    });
    return Response.json({ ok: true });
  } catch (error) {
    // No liberamos el intento si el proveedor no confirmo la cancelacion: evita
    // que el comprador abra una segunda operacion que pudiera cobrar duplicado.
    console.error('[payment-attempt:cancel]', attempt.id, error.message);
    return Response.json({
      error: 'No pudimos cerrar el intento todavia. Espera un momento antes de abrir otro pago.',
    }, { status: 503 });
  }
}
