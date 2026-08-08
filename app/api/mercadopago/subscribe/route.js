import { z } from 'zod';
import { getCurrentUser } from '../../../../lib/auth-pg';
import {
  createPreapproval,
  createOrder,
  getMercadoPagoPayment,
  isValidPlan,
  mercadoPagoPeriodEnd,
  MercadoPagoApiError,
} from '../../../../lib/mercadopago';
import { supabaseAdmin } from '../../../../lib/supabase';
import { redisRateLimit } from '../../../../lib/ratelimit-redis';
import { resolvePaymentGeo } from '../../../../lib/payment-geo';
import {
  activatePaidAccess,
  reservePaymentAttempt,
  updatePaymentAttempt,
} from '../../../../lib/payment-store';
import { hasActiveEntitlement } from '../../../../lib/entitlements';
import { jsonError } from '../../../../lib/api-error';

export const dynamic = 'force-dynamic';

// PSE exige contacto y direccion, aunque el Payment Brick de Mercado Pago solo
// recoja email, documento, tipo de persona y banco. Verificado contra produccion:
// el mismo pago SIN phone/address devuelve 424 "BankTransfers Api fail" y CON
// ellos crea el pago (pending_waiting_transfer). Por eso los pedimos aparte.
// Longitudes exactas de la spec de PSE.
const billingSchema = z.object({
  firstName: z.string().trim().min(1).max(32),
  lastName: z.string().trim().min(1).max(32),
  zipCode: z.string().regex(/^\d{5}$/),
  streetName: z.string().trim().min(1).max(18),
  streetNumber: z.string().trim().min(1).max(5),
  neighborhood: z.string().trim().min(1).max(18),
  city: z.string().trim().min(1).max(18),
  phoneAreaCode: z.string().regex(/^\d{3}$/),
  phoneNumber: z.string().regex(/^\d{1,7}$/),
  federalUnit: z.string().trim().max(18).optional().default(''),
});

const subscribeSchema = z.object({
  plan: z.string(),
  attemptId: z.string().uuid(),
  selectedPaymentMethod: z.string().optional().nullable(),
  formData: z.record(z.string(), z.unknown()).optional().default({}),
  billingDetails: z.record(z.string(), z.unknown()).optional().default({}),
  country: z.string().length(2).optional().nullable(),
});

function paymentMethodId(formData, selected) {
  return String(formData?.payment_method_id || formData?.paymentMethodId || selected || '').toLowerCase();
}

function validPseBrickData(formData) {
  const payer = formData?.payer || {};
  const identification = payer.identification || {};
  const institution = formData?.transaction_details?.financial_institution
    || formData?.financial_institution
    || payer.financial_institution;
  const documentNumber = String(identification.number || '').trim();
  return !!institution
    && ['individual', 'association'].includes(String(payer.entity_type || 'individual'))
    && ['CC', 'CE', 'NIT', 'Otro', 'TE', 'RC', 'TI', 'PAS', 'DI'].includes(String(identification.type || ''))
    && /^[A-Za-z0-9]{1,15}$/.test(documentNumber);
}

function publicMpError(error) {
  if (error.code === 'PAYMENT_IN_PROGRESS') {
    return Response.json({
      error: 'Ya tienes un pago abierto. Cierralo antes de cambiar de metodo o plan.',
      code: error.code,
      attemptId: error.attemptId,
    }, { status: 409 });
  }
  if (error instanceof MercadoPagoApiError) {
    const bankTransient = error.transient || /BankTransfers|903[24]|failed_dependency/i.test(error.message);
    return Response.json({
      error: bankTransient
        ? 'El banco o Mercado Pago no respondio a tiempo. Tu intento queda guardado: reintenta sin riesgo de doble cobro.'
        : 'Mercado Pago rechazo la operacion. Revisa los datos e intenta nuevamente.',
      code: bankTransient ? 'PROVIDER_TEMPORARY' : 'PAYMENT_REJECTED',
      retryable: bankTransient,
    }, { status: bankTransient ? 503 : 422 });
  }
  return null;
}

export async function POST(request) {
  let activeAttemptId = null;
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const parsed = subscribeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || !isValidPlan(parsed.data?.plan)) {
      return Response.json({ error: 'Datos de pago invalidos' }, { status: 400 });
    }
    const { plan, attemptId, selectedPaymentMethod, formData, billingDetails, country } = parsed.data;

    const limit = await redisRateLimit('mp-checkout', user.id, 8, 5 * 60);
    if (!limit.success) {
      return Response.json({ error: 'Demasiados intentos. Espera unos minutos.' }, { status: 429 });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('user_profiles')
      .select('id, email, name, role, plan, subscription_status, plan_expires_at, subscription_current_period_end, cancel_at_period_end')
      .eq('id', user.id)
      .single();
    if (profileError || !profile) return Response.json({ error: 'Usuario no encontrado' }, { status: 404 });
    if (hasActiveEntitlement(profile)) {
      return Response.json({ error: 'Tu cuenta ya tiene un plan activo.', code: 'ALREADY_ACTIVE' }, { status: 409 });
    }

    const geo = await resolvePaymentGeo(request, { country, currency: 'COP' });
    if (geo.country && geo.country !== 'CO') {
      return Response.json({ error: 'Mercado Pago esta disponible para compras desde Colombia.', code: 'USE_STRIPE' }, { status: 409 });
    }

    const token = formData?.token;
    const methodId = paymentMethodId(formData, selectedPaymentMethod);
    // Nequi y PSE viajan los dos como `bank_transfer` en el Payment Brick, pero
    // Nequi no tiene banco que elegir: mezclarlos le exigia datos que ese metodo
    // nunca entrega.
    const isNequi = methodId === 'nequi';
    const isPse = !isNequi && (methodId === 'pse' || selectedPaymentMethod === 'bank_transfer');
    if (!token && !methodId) {
      return Response.json({ error: 'Selecciona un metodo de pago.' }, { status: 400 });
    }
    let billingData = {};
    if (isPse) {
      if (!validPseBrickData(formData)) {
        return Response.json({
          error: 'Vuelve a seleccionar el banco y completa el documento solicitado por PSE.',
          code: 'PSE_PROVIDER_FIELDS_MISSING',
        }, { status: 400 });
      }
      const billing = billingSchema.safeParse(billingDetails);
      if (!billing.success) {
        return Response.json({
          error: 'PSE necesita tus datos de contacto y direccion (Nequi y DaviPlata tambien van por PSE). Los tienes justo arriba del formulario de pago.',
          code: 'PSE_BILLING_REQUIRED',
          fields: billing.error.flatten().fieldErrors,
        }, { status: 400 });
      }
      billingData = billing.data;
    }

    const kind = token ? 'subscription' : 'one_time';
    const { attempt } = await reservePaymentAttempt({
      id: attemptId,
      userId: user.id,
      provider: 'mercadopago',
      kind,
      plan,
      currency: 'COP',
    });
    activeAttemptId = attempt.id;

    // Un POST cuyo response se perdio se recupera por la fila durable; nunca
    // creamos otra operacion con otra idempotency key.
    if (attempt.provider_resource_id) {
      if (attempt.status === 'succeeded') {
        return Response.json({ ok: true, active: true, attemptId: attempt.id, statusUrl: `/pago/estado?attempt=${attempt.id}` });
      }
      if (kind === 'one_time') {
        const payment = await getMercadoPagoPayment(attempt.provider_resource_id);
        const redirectUrl = payment?.transaction_details?.external_resource_url
          || payment?.point_of_interaction?.transaction_data?.ticket_url
          || null;
        return Response.json({ ok: true, pending: true, attemptId: attempt.id, redirectUrl, statusUrl: `/pago/estado?attempt=${attempt.id}` });
      }
      return Response.json({ ok: true, pending: true, attemptId: attempt.id, statusUrl: `/pago/estado?attempt=${attempt.id}` });
    }

    const backUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://cfanalisis.com'}/pago/estado?attempt=${attempt.id}`;
    let result;
    if (token) {
      result = await createPreapproval({
        plan,
        email: profile.email,
        userId: user.id,
        backUrl,
        cardToken: token,
        attemptId: attempt.id,
      });
    } else {
      const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || request.headers.get('x-real-ip')?.trim()
        || null;
      result = await createOrder({
        plan,
        formData,
        userId: user.id,
        email: profile.email,
        backUrl,
        ipAddress: ip,
        billingDetails: billingData,
        payerName: profile.name,
        attemptId: attempt.id,
      });
    }

    const saved = await updatePaymentAttempt(attempt.id, {
      status: result.status === 'approved' ? 'processing' : 'requires_payment',
      amount: result.amountCop,
      currency: 'COP',
      provider_resource_id: String(result.id),
      last_provider_status: result.status,
      metadata: { paymentMethod: methodId || 'card' },
    });
    if (!saved) throw new Error('No se pudo guardar el intento de Mercado Pago');
    if (saved.status === 'succeeded') {
      return Response.json({ ok: true, active: true, attemptId: saved.id, statusUrl: `/pago/estado?attempt=${saved.id}` });
    }

    if (!token && result.status === 'approved') {
      await activatePaidAccess({
        attemptId: attempt.id,
        userId: user.id,
        plan,
        provider: 'mercadopago',
        subscriptionId: String(result.id),
        paymentId: String(result.id),
        amount: result.amountCop,
        currency: 'COP',
        periodEnd: mercadoPagoPeriodEnd(plan),
        providerStatus: result.status,
      });
      return Response.json({ ok: true, active: true, attemptId: attempt.id, statusUrl: `/pago/estado?attempt=${attempt.id}` });
    }

    return Response.json({
      ok: true,
      pending: true,
      status: result.status,
      attemptId: attempt.id,
      redirectUrl: result.redirectUrl || null,
      statusUrl: `/pago/estado?attempt=${attempt.id}`,
    });
  } catch (error) {
    if (activeAttemptId) {
      await updatePaymentAttempt(activeAttemptId, {
        status: error?.transient ? 'processing' : 'failed',
        error_code: error.code || 'MP_ERROR',
        error_message: String(error.message || error).slice(0, 800),
      }).catch(() => {});
    }
    const publicError = publicMpError(error);
    if (publicError) return publicError;
    console.error('[mp:subscribe]', error.message);
    return jsonError(error, { status: 502, publicMessage: 'No se pudo procesar el pago. Intenta de nuevo.' });
  }
}
