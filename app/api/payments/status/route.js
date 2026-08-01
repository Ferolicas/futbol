import { getCurrentUser } from '../../../../lib/auth-pg';
import { redisRateLimit } from '../../../../lib/ratelimit-redis';
import {
  getPaymentAccessProfile,
  getPaymentAttemptForUser,
} from '../../../../lib/payment-store';
import { reconcilePaymentAttempt } from '../../../../lib/payment-reconcile';
import { hasActiveEntitlement } from '../../../../lib/entitlements';

export const dynamic = 'force-dynamic';

const TERMINAL = new Set(['succeeded', 'cancelled', 'expired']);

export async function GET(request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const limit = await redisRateLimit('payment-status', user.id, 90, 60);
  if (!limit.success) return Response.json({ error: 'Espera unos segundos.' }, { status: 429 });

  const attemptId = new URL(request.url).searchParams.get('attempt');
  let attempt = await getPaymentAttemptForUser(attemptId, user.id);
  if (!attempt) return Response.json({ error: 'Intento de pago no encontrado' }, { status: 404 });

  let verificationDelayed = false;
  const lastCheck = attempt.last_reconciled_at ? new Date(attempt.last_reconciled_at).getTime() : 0;
  if (!TERMINAL.has(attempt.status) && Date.now() - lastCheck > 3_000 && attempt.provider_resource_id) {
    try {
      await reconcilePaymentAttempt(attempt);
      attempt = await getPaymentAttemptForUser(attemptId, user.id);
    } catch (error) {
      verificationDelayed = true;
      console.error('[payment-status:reconcile]', attemptId, error.message);
    }
  }

  const profile = await getPaymentAccessProfile(user.id);
  const access = hasActiveEntitlement(profile);
  if (attempt.status === 'succeeded' && access) {
    return Response.json({
      status: 'succeeded',
      access: true,
      plan: attempt.plan,
      redirectUrl: '/dashboard?checkout=success',
    });
  }

  if (attempt.status === 'succeeded' && !access) {
    return Response.json({
      status: 'failed',
      access: false,
      code: 'access_period_ended',
      message: 'Este periodo de acceso ya termino. Puedes elegir un plan nuevo.',
    });
  }

  if (['cancelled', 'expired'].includes(attempt.status)) {
    return Response.json({
      status: 'failed',
      access: false,
      code: attempt.status,
      message: attempt.status === 'expired'
        ? 'El formulario vencio sin realizar ningun cobro.'
        : 'El pago fue cancelado y no se realizo ningun cobro.',
    });
  }

  if (attempt.status === 'failed') {
    return Response.json({
      status: 'failed',
      access: false,
      code: attempt.error_code || attempt.last_provider_status || 'payment_failed',
      message: 'El pago no fue aprobado. Puedes corregir los datos o usar otro metodo sin riesgo de doble cobro.',
    });
  }

  return Response.json({
    status: 'pending',
    access,
    plan: attempt.plan,
    provider: attempt.provider,
    verificationDelayed,
    message: verificationDelayed
      ? 'El proveedor esta tardando en responder. Tu pago quedo guardado y seguiremos verificandolo.'
      : 'Estamos confirmando el pago directamente con el proveedor.',
  });
}
