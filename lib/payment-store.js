import { pgPool, pgQuery } from './db';
import { sendPlanActivatedEmail } from './email';

export const OPEN_PAYMENT_STATUSES = ['creating', 'requires_payment', 'processing'];
const ATTEMPT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidPaymentAttemptId(value) {
  return typeof value === 'string' && ATTEMPT_ID_RE.test(value);
}

function paymentError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

export async function reservePaymentAttempt({ id, userId, provider, kind, plan, currency = null }) {
  if (!isValidPaymentAttemptId(id)) throw paymentError('INVALID_ATTEMPT', 'Intento de pago invalido');

  try {
    const inserted = await pgQuery(
      `INSERT INTO public.payment_attempts (id, user_id, provider, kind, plan, currency)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [id, userId, provider, kind, plan, currency?.toUpperCase() || null],
    );
    if (inserted.rows[0]) return { attempt: inserted.rows[0], created: true };
  } catch (error) {
    if (error.code !== '23505') throw error;
  }

  const existingById = await pgQuery(
    'SELECT * FROM public.payment_attempts WHERE id = $1 LIMIT 1',
    [id],
  );
  const openAttempt = (await pgQuery(
    `SELECT * FROM public.payment_attempts
      WHERE user_id = $1 AND status = ANY($2::text[])
      ORDER BY created_at DESC LIMIT 1`,
    [userId, OPEN_PAYMENT_STATUSES],
  )).rows[0];
  // Si existe otro intento abierto, siempre gana sobre un ID terminal viejo.
  // Asi dos pestañas no pueden crear dos suscripciones simultaneas.
  const existing = openAttempt || existingById.rows[0];

  if (!existing) {
    // Una carrera pudo cerrar el intento entre INSERT y SELECT: reintentar una vez.
    return reservePaymentAttempt({ id, userId, provider, kind, plan, currency });
  }
  if (existing.user_id !== userId) {
    throw paymentError('ATTEMPT_OWNERSHIP', 'El intento de pago no pertenece a esta cuenta');
  }
  if (existing.provider !== provider) {
    throw paymentError('PAYMENT_IN_PROGRESS', 'Ya existe un pago abierto con otro proveedor', {
      attemptId: existing.id,
      existingPlan: existing.plan,
      existingProvider: existing.provider,
    });
  }
  if (existing.plan !== plan || existing.kind !== kind) {
    throw paymentError('PAYMENT_IN_PROGRESS', 'Ya existe un pago abierto con otro plan', {
      attemptId: existing.id,
      existingPlan: existing.plan,
    });
  }

  return { attempt: existing, created: false };
}

export async function getPaymentAttemptForUser(id, userId) {
  if (!isValidPaymentAttemptId(id)) return null;
  const result = await pgQuery(
    'SELECT * FROM public.payment_attempts WHERE id = $1 AND user_id = $2 LIMIT 1',
    [id, userId],
  );
  return result.rows[0] || null;
}

export async function getPaymentAttemptByResource(provider, resourceId) {
  if (!resourceId) return null;
  const result = await pgQuery(
    `SELECT * FROM public.payment_attempts
      WHERE provider = $1 AND provider_resource_id = $2 LIMIT 1`,
    [provider, String(resourceId)],
  );
  return result.rows[0] || null;
}

export async function updatePaymentAttempt(id, patch) {
  const allowed = new Set([
    'status', 'amount', 'currency', 'provider_customer_id', 'provider_resource_id',
    'provider_payment_id', 'last_provider_status', 'error_code', 'error_message',
    'last_reconciled_at', 'expires_at', 'completed_at', 'metadata',
  ]);
  const entries = Object.entries(patch || {}).filter(([key]) => allowed.has(key));
  if (!entries.length) return null;

  const params = [];
  const sets = entries.map(([key, value]) => {
    params.push(value);
    if (key === 'status') {
      return `"status" = CASE
        WHEN "status" = 'succeeded' AND $${params.length} <> 'succeeded'
          THEN "status"
        ELSE $${params.length}
      END`;
    }
    return `"${key}" = $${params.length}`;
  });
  params.push(id);
  const result = await pgQuery(
    `UPDATE public.payment_attempts SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return result.rows[0] || null;
}

export async function listPaymentAttemptsForReconciliation(limit = 50) {
  const result = await pgQuery(
    `SELECT * FROM public.payment_attempts
      WHERE status = ANY($1::text[])
        AND created_at > NOW() - interval '7 days'
        AND (
          last_reconciled_at IS NULL
          OR (status = 'failed' AND last_reconciled_at < NOW() - interval '15 minutes')
          OR (status <> 'failed' AND last_reconciled_at < NOW() - interval '20 seconds')
        )
      ORDER BY created_at ASC
      LIMIT $2`,
    [['requires_payment', 'processing', 'failed'], Math.max(1, Math.min(100, Number(limit) || 50))],
  );
  return result.rows;
}

export async function listPaymentProfilesForReconciliation(limit = 50) {
  const result = await pgQuery(
    `SELECT id, plan, subscription_status, payment_provider, stripe_customer_id,
            stripe_subscription_id, mp_preapproval_id, plan_expires_at,
            subscription_current_period_end, cancel_at_period_end
       FROM public.user_profiles
      WHERE role = 'user'
        AND payment_provider IN ('stripe', 'mercadopago')
        AND subscription_status IN ('active', 'past_due', 'cancelled')
        AND (stripe_subscription_id IS NOT NULL OR mp_preapproval_id IS NOT NULL)
        AND (
          subscription_reconciled_at IS NULL
          OR (subscription_status = 'past_due' AND subscription_reconciled_at < NOW() - interval '15 minutes')
          OR (
            COALESCE(subscription_current_period_end, plan_expires_at)
              BETWEEN NOW() - interval '24 hours' AND NOW() + interval '30 minutes'
            AND subscription_reconciled_at < NOW() - interval '5 minutes'
          )
          OR (subscription_status <> 'past_due' AND subscription_reconciled_at < NOW() - interval '6 hours')
        )
      ORDER BY subscription_reconciled_at ASC NULLS FIRST
      LIMIT $1`,
    [Math.max(1, Math.min(100, Number(limit) || 50))],
  );
  return result.rows;
}

export async function markPaymentProfileReconciled(userId) {
  await pgQuery(
    'UPDATE public.user_profiles SET subscription_reconciled_at = NOW() WHERE id = $1',
    [userId],
  );
}

export async function listActivationEmailsForRetry(limit = 20) {
  const result = await pgQuery(
    `SELECT id FROM public.payment_attempts
      WHERE status = 'succeeded' AND activation_email_sent_at IS NULL
        AND (activation_email_status IN ('pending', 'failed')
             OR (activation_email_status = 'sending' AND updated_at < NOW() - interval '10 minutes'))
        AND activation_email_attempts < 6
      ORDER BY updated_at ASC LIMIT $1`,
    [Math.max(1, Math.min(50, Number(limit) || 20))],
  );
  return result.rows;
}

export async function claimWebhookEvent({ provider, eventId, eventType, resourceId }) {
  const result = await pgQuery(
    `INSERT INTO public.payment_webhook_events
       (provider, event_id, event_type, resource_id, status, attempts)
     VALUES ($1, $2, $3, $4, 'processing', 1)
     ON CONFLICT (provider, event_id) DO UPDATE SET
       event_type = EXCLUDED.event_type,
       resource_id = COALESCE(EXCLUDED.resource_id, payment_webhook_events.resource_id),
       status = 'processing',
       attempts = payment_webhook_events.attempts + 1,
       error_message = NULL,
       processing_at = NOW(),
       updated_at = NOW()
     WHERE payment_webhook_events.status = 'failed'
        OR (payment_webhook_events.status = 'processing'
            AND payment_webhook_events.processing_at < NOW() - interval '5 minutes')
     RETURNING provider, event_id`,
    [provider, String(eventId), String(eventType || 'unknown'), resourceId ? String(resourceId) : null],
  );
  if (result.rows.length > 0) return 'claimed';
  const existing = (await pgQuery(
    `SELECT status FROM public.payment_webhook_events
      WHERE provider = $1 AND event_id = $2 LIMIT 1`,
    [provider, String(eventId)],
  )).rows[0];
  return existing?.status || 'processing';
}

export async function completeWebhookEvent(provider, eventId) {
  await pgQuery(
    `UPDATE public.payment_webhook_events
        SET status = 'completed', processed_at = NOW(), updated_at = NOW(), error_message = NULL
      WHERE provider = $1 AND event_id = $2`,
    [provider, String(eventId)],
  );
}

export async function failWebhookEvent(provider, eventId, error) {
  await pgQuery(
    `UPDATE public.payment_webhook_events
        SET status = 'failed', error_message = $3, updated_at = NOW()
      WHERE provider = $1 AND event_id = $2`,
    [provider, String(eventId), String(error?.message || error || 'unknown').slice(0, 1000)],
  );
}

export async function findPaymentOwner({ attemptId, userId, provider, customerId, subscriptionId }) {
  if (attemptId && isValidPaymentAttemptId(attemptId)) {
    const attempt = (await pgQuery(
      'SELECT * FROM public.payment_attempts WHERE id = $1 AND provider = $2 LIMIT 1',
      [attemptId, provider],
    )).rows[0];
    if (attempt) return { attempt, userId: attempt.user_id, plan: attempt.plan };
  }

  if (subscriptionId) {
    const attempt = await getPaymentAttemptByResource(provider, subscriptionId);
    if (attempt) return { attempt, userId: attempt.user_id, plan: attempt.plan };
  }

  if (userId) {
    const openAttempt = (await pgQuery(
      `SELECT * FROM public.payment_attempts
        WHERE user_id = $1 AND provider = $2
          AND status = ANY($3::text[])
        ORDER BY created_at DESC LIMIT 1`,
      [userId, provider, OPEN_PAYMENT_STATUSES],
    )).rows[0];
    if (openAttempt) {
      return { attempt: openAttempt, userId: openAttempt.user_id, plan: openAttempt.plan };
    }

    const profile = (await pgQuery(
      'SELECT id, plan FROM public.user_profiles WHERE id = $1 LIMIT 1',
      [userId],
    )).rows[0];
    if (profile) return { attempt: null, userId: profile.id, plan: profile.plan };
  }

  if (customerId) {
    const column = provider === 'stripe' ? 'stripe_customer_id' : 'mp_preapproval_id';
    const profile = (await pgQuery(
      `SELECT id, plan FROM public.user_profiles WHERE ${column} = $1 LIMIT 1`,
      [String(customerId)],
    )).rows[0];
    if (profile) return { attempt: null, userId: profile.id, plan: profile.plan };
  }

  return null;
}

export async function activatePaidAccess({
  attemptId = null,
  userId,
  plan,
  provider,
  customerId = null,
  subscriptionId = null,
  paymentId = null,
  amount = null,
  currency = null,
  periodEnd = null,
  providerStatus = 'paid',
  cancelAtPeriodEnd = false,
}) {
  const client = await pgPool.connect();
  let profile;
  let resolvedAttemptId = attemptId;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payment:${userId}`]);

    let attempt = null;
    if (resolvedAttemptId) {
      attempt = (await client.query(
        'SELECT * FROM public.payment_attempts WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [resolvedAttemptId, userId],
      )).rows[0] || null;
    }
    if (!attempt && subscriptionId) {
      attempt = (await client.query(
        `SELECT * FROM public.payment_attempts
          WHERE provider = $1 AND provider_resource_id = $2 FOR UPDATE`,
        [provider, String(subscriptionId)],
      )).rows[0] || null;
      resolvedAttemptId = attempt?.id || null;
    }
    if (attempt && attempt.provider !== provider) {
      throw paymentError('PAYMENT_PROVIDER_MISMATCH', 'El intento pertenece a otro proveedor');
    }
    if (
      attempt?.provider_resource_id
      && subscriptionId
      && String(attempt.provider_resource_id) !== String(subscriptionId)
    ) {
      throw paymentError('PAYMENT_RESOURCE_MISMATCH', 'El intento pertenece a otro recurso de pago');
    }

    const recordsNewPayment = !!paymentId
      && !(attempt?.status === 'succeeded'
        && String(attempt.provider_payment_id || '') === String(paymentId));

    const current = (await client.query(
      `SELECT id, email, name, role, plan, subscription_status
         FROM public.user_profiles WHERE id = $1 FOR UPDATE`,
      [userId],
    )).rows[0];
    if (!current) throw paymentError('PAYMENT_USER_NOT_FOUND', 'Usuario de pago no encontrado');

    const effectivePlan = attempt?.plan || plan;
    if (!effectivePlan) throw paymentError('PAYMENT_PLAN_MISSING', 'El pago no contiene un plan valido');

    const values = [
      effectivePlan,
      provider,
      customerId,
      provider === 'stripe' ? subscriptionId : null,
      provider === 'mercadopago' ? subscriptionId : null,
      periodEnd,
      amount,
      currency?.toUpperCase() || null,
      recordsNewPayment,
      !!cancelAtPeriodEnd,
      userId,
    ];
    profile = (await client.query(
      `UPDATE public.user_profiles SET
         plan = $1,
         subscription_status = 'active',
         payment_provider = $2,
         stripe_customer_id = CASE WHEN $2 = 'stripe' THEN COALESCE($3, stripe_customer_id) ELSE stripe_customer_id END,
         stripe_subscription_id = CASE WHEN $2 = 'stripe' THEN COALESCE($4, stripe_subscription_id) ELSE stripe_subscription_id END,
         mp_preapproval_id = CASE WHEN $2 = 'mercadopago' THEN COALESCE($5, mp_preapproval_id) ELSE mp_preapproval_id END,
         subscription_current_period_end = CASE
           WHEN $6::timestamptz IS NULL THEN subscription_current_period_end
           WHEN subscription_current_period_end IS NULL THEN $6
           ELSE GREATEST(subscription_current_period_end, $6)
         END,
         plan_expires_at = CASE
           WHEN $6::timestamptz IS NULL THEN plan_expires_at
           WHEN plan_expires_at IS NULL THEN $6
           ELSE GREATEST(plan_expires_at, $6)
         END,
         cancel_at_period_end = $10,
         last_payment_at = CASE WHEN $9 THEN NOW() ELSE last_payment_at END,
         last_payment_amount = CASE WHEN $9 THEN COALESCE($7, last_payment_amount) ELSE last_payment_amount END,
         last_payment_currency = CASE WHEN $9 THEN COALESCE($8, last_payment_currency) ELSE last_payment_currency END,
         subscription_setup_status = 'done',
         subscription_setup_error = NULL,
         subscription_reconciled_at = NOW(),
         updated_at = NOW()
       WHERE id = $11
       RETURNING id, email, name, plan, subscription_status`,
      values,
    )).rows[0];

    if (resolvedAttemptId) {
      await client.query(
        `UPDATE public.payment_attempts SET
           status = 'succeeded', provider_payment_id = COALESCE($2, provider_payment_id),
           last_provider_status = $3, amount = COALESCE($4, amount),
           currency = COALESCE($5, currency), completed_at = COALESCE(completed_at, NOW()),
           provider_customer_id = COALESCE($6, provider_customer_id),
           provider_resource_id = COALESCE($7, provider_resource_id),
           last_reconciled_at = NOW(), error_code = NULL, error_message = NULL, updated_at = NOW()
         WHERE id = $1`,
        [
          resolvedAttemptId,
          paymentId ? String(paymentId) : null,
          providerStatus,
          amount,
          currency?.toUpperCase() || null,
          customerId ? String(customerId) : null,
          subscriptionId ? String(subscriptionId) : null,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  if (resolvedAttemptId) void deliverActivationEmail(resolvedAttemptId);
  return profile;
}

export async function syncSubscriptionStatus({
  userId,
  provider,
  status,
  customerId = null,
  subscriptionId = null,
  periodEnd = null,
  cancelAtPeriodEnd = false,
  providerStatus = null,
}) {
  const result = await pgQuery(
    `UPDATE public.user_profiles SET
       subscription_status = $1,
       payment_provider = COALESCE($2, payment_provider),
       stripe_customer_id = CASE WHEN $2 = 'stripe' THEN COALESCE($3, stripe_customer_id) ELSE stripe_customer_id END,
       stripe_subscription_id = CASE WHEN $2 = 'stripe' THEN COALESCE($4, stripe_subscription_id) ELSE stripe_subscription_id END,
       mp_preapproval_id = CASE WHEN $2 = 'mercadopago' THEN COALESCE($4, mp_preapproval_id) ELSE mp_preapproval_id END,
       subscription_current_period_end = CASE
         WHEN $5::timestamptz IS NULL THEN subscription_current_period_end
         WHEN subscription_current_period_end IS NULL THEN $5
         ELSE GREATEST(subscription_current_period_end, $5)
       END,
       plan_expires_at = CASE
         WHEN $5::timestamptz IS NULL THEN plan_expires_at
         WHEN plan_expires_at IS NULL THEN $5
         ELSE GREATEST(plan_expires_at, $5)
       END,
       cancel_at_period_end = $6,
       subscription_reconciled_at = NOW(),
       updated_at = NOW()
     WHERE id = $7
       AND (
         payment_provider IS NULL
         OR (
           payment_provider = $2
           AND (
             $4::text IS NULL
             OR ($2 = 'stripe' AND (stripe_subscription_id IS NULL OR stripe_subscription_id = $4))
             OR ($2 = 'mercadopago' AND (mp_preapproval_id IS NULL OR mp_preapproval_id = $4))
           )
         )
       )
     RETURNING id, plan, subscription_status`,
    [status, provider, customerId, subscriptionId, periodEnd, !!cancelAtPeriodEnd, userId],
  );
  if (!result.rows[0]) {
    const exists = (await pgQuery(
      'SELECT id FROM public.user_profiles WHERE id = $1 LIMIT 1',
      [userId],
    )).rows[0];
    if (!exists) throw paymentError('PAYMENT_USER_NOT_FOUND', 'Usuario de pago no encontrado');
    // Evento viejo de otro proveedor o de una suscripcion reemplazada. Se
    // confirma al proveedor, pero jamas pisa el derecho vigente del cliente.
    return { id: userId, ignored: true };
  }

  if (subscriptionId) {
    await pgQuery(
      `UPDATE public.payment_attempts
          SET last_provider_status = COALESCE($3, last_provider_status),
              last_reconciled_at = NOW(), updated_at = NOW()
        WHERE provider = $1 AND provider_resource_id = $2`,
      [provider, String(subscriptionId), providerStatus],
    );
  }
  return result.rows[0];
}

export async function getPaymentAccessProfile(userId) {
  const result = await pgQuery(
    `SELECT id, role, plan, subscription_status, payment_provider,
            plan_expires_at, subscription_current_period_end, cancel_at_period_end
       FROM public.user_profiles WHERE id = $1 LIMIT 1`,
    [userId],
  );
  return result.rows[0] || null;
}

export async function deliverActivationEmail(attemptId) {
  const claimed = (await pgQuery(
    `UPDATE public.payment_attempts
        SET activation_email_status = 'sending',
            activation_email_attempts = activation_email_attempts + 1,
            updated_at = NOW()
      WHERE id = $1
        AND status = 'succeeded'
        AND activation_email_sent_at IS NULL
        AND (activation_email_status IN ('pending', 'failed')
             OR (activation_email_status = 'sending' AND updated_at < NOW() - interval '10 minutes'))
      RETURNING user_id, plan`,
    [attemptId],
  )).rows[0];
  if (!claimed) return false;

  try {
    const profile = (await pgQuery(
      'SELECT email, name FROM public.user_profiles WHERE id = $1 LIMIT 1',
      [claimed.user_id],
    )).rows[0];
    if (!profile?.email) throw new Error('Perfil sin email');
    await sendPlanActivatedEmail({ to: profile.email, name: profile.name, plan: claimed.plan });
    await pgQuery(
      `UPDATE public.payment_attempts SET activation_email_status = 'sent',
         activation_email_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [attemptId],
    );
    return true;
  } catch (error) {
    await pgQuery(
      `UPDATE public.payment_attempts SET activation_email_status = 'failed',
         error_message = COALESCE(error_message, $2), updated_at = NOW() WHERE id = $1`,
      [attemptId, `activation_email: ${String(error.message || error).slice(0, 500)}`],
    );
    console.error('[payments:activation-email]', attemptId, error.message);
    return false;
  }
}
