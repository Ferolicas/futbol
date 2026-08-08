// ─────────────────────────────────────────────────────────────────────────────
// lib/mercadopago.js — Suscripciones de Mercado Pago para Colombia.
//
// Geo-routing: Colombia → Mercado Pago; resto del mundo → Stripe. Para Colombia,
// MP cubre los métodos locales (tarjeta, PSE, Efecty) y, con tarjeta, el cobro
// recurrente automático (preapproval).
//
// Modelo de precio (acordado 2026-06): el precio de referencia es en EUR (fuente
// única: PLANS de lib/stripe.js) y se convierte a COP EN VIVO con la API sin key
// open.er-api.com (vía lib/currency.js) en el momento de crear la suscripción.
// El monto en COP queda fijado en el preapproval y MP lo cobra automáticamente
// cada periodo; cada activación NUEVA usa la tasa EUR→COP del día.
// ─────────────────────────────────────────────────────────────────────────────
import { createHmac, timingSafeEqual } from 'crypto';
import { PLANS } from './stripe';
import { convertAmount } from './currency';
import { pgQuery } from './db';

const MP_API = 'https://api.mercadopago.com';

export class MercadoPagoApiError extends Error {
  constructor(message, status, body = null) {
    super(message);
    this.name = 'MercadoPagoApiError';
    this.status = status;
    this.body = body;
    this.code = body?.error || body?.code || `MP_${status}`;
    this.transient = status === 408 || status === 409 || status === 424 || status === 429 || status >= 500;
  }
}

async function mpFetch(path, options = {}) {
  const { signal: suppliedSignal, headers: suppliedHeaders, ...fetchOptions } = options;
  const headers = {
    Authorization: `Bearer ${mpAccessToken()}`,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(suppliedHeaders || {}),
  };
  const method = String(options.method || 'GET').toUpperCase();
  const idempotent = ['GET', 'HEAD'].includes(method)
    || Object.keys(headers).some((name) => name.toLowerCase() === 'x-idempotency-key');
  const maxAttempts = idempotent && !suppliedSignal ? 2 : 1;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(`${MP_API}${path}`, {
        ...fetchOptions,
        headers,
        cache: 'no-store',
        signal: suppliedSignal || AbortSignal.timeout(9_000),
      });
    } catch (error) {
      lastError = new MercadoPagoApiError(`Mercado Pago network error: ${error.message}`, 503);
      if (attempt === maxAttempts) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      continue;
    }

    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    lastError = new MercadoPagoApiError(
      `Mercado Pago ${response.status}: ${JSON.stringify(data).slice(0, 400)}`,
      response.status,
      data,
    );
    if (!lastError.transient || attempt === maxAttempts) throw lastError;
    const retryAfter = Math.min(2_000, Math.max(0, Number(response.headers.get('retry-after') || 0) * 1000));
    await new Promise((resolve) => setTimeout(resolve, retryAfter || 250 * attempt));
  }
  throw lastError;
}

// Token de acceso: producción si MP_ENV=live, de prueba en cualquier otro caso.
export function mpAccessToken() {
  return process.env.MP_ENV === 'live'
    ? process.env.MP_ACCESS_TOKEN
    : process.env.MP_ACCESS_TOKEN_TEST;
}

// Frecuencia de cobro por plan (auto_recurring de MP: "days" o "months").
const PLAN_FREQUENCY = {
  semanal:    { frequency: 7,  frequency_type: 'days' },
  mensual:    { frequency: 1,  frequency_type: 'months' },
  trimestral: { frequency: 3,  frequency_type: 'months' },
  semestral:  { frequency: 6,  frequency_type: 'months' },
  anual:      { frequency: 12, frequency_type: 'months' },
};

export const isValidPlan = (plan) =>
  Object.prototype.hasOwnProperty.call(PLAN_FREQUENCY, plan) && !!PLANS[plan];

// Precio de referencia del plan en EUR (desde la fuente única PLANS).
export function planEur(plan) {
  const cfg = PLANS[plan];
  return cfg ? cfg.price / 100 : null;
}

// Convierte el precio EUR del plan a COP a la tasa del día (open.er-api.com).
// Devuelve un entero (COP no usa decimales). null si la conversión no es fiable.
export async function planAmountCop(plan) {
  const eur = planEur(plan);
  if (eur == null) return null;
  const conv = await convertAmount(eur, 'COP', 'EUR');
  if (!conv.fallback && conv.currency === 'COP' && conv.amount > 0 && conv.rate > 0) {
    // La ultima tasa valida sobrevive reinicios y caidas del proveedor FX.
    await pgQuery(
      `INSERT INTO public.payment_exchange_rates (source_currency, target_currency, rate, observed_at)
       VALUES ('EUR', 'COP', $1, NOW())
       ON CONFLICT (source_currency, target_currency)
       DO UPDATE SET rate = EXCLUDED.rate, observed_at = EXCLUDED.observed_at`,
      [conv.rate],
    ).catch((error) => console.error('[mp:fx-cache]', error.message));
    return Math.round(conv.amount);
  }

  const cached = await pgQuery(
    `SELECT rate FROM public.payment_exchange_rates
      WHERE source_currency = 'EUR' AND target_currency = 'COP'
        AND observed_at > NOW() - interval '7 days'
      LIMIT 1`,
  ).catch(() => ({ rows: [] }));
  const rate = Number(cached.rows[0]?.rate || 0);
  return rate > 0 ? Math.round(eur * rate) : null;
}

// Crea una suscripción (preapproval) recurrente. El monto en COP queda fijado a
// la tasa del día.
//   - CON cardToken (modal embebido, Card Brick): status 'authorized' → queda
//     activa de inmediato, SIN redirigir. Es el flujo por defecto.
//   - SIN cardToken (fallback): status 'pending' → devuelve init_point (checkout
//     alojado de MP) por si alguna vez se quiere el flujo redirigido.
export async function createPreapproval({ plan, email, userId, backUrl, cardToken, attemptId }) {
  if (!isValidPlan(plan)) throw new Error(`Plan inválido: ${plan}`);
  const amountCop = await planAmountCop(plan);
  if (!amountCop) throw new Error('No se pudo convertir el precio EUR→COP');

  const body = {
    reason: `CF Análisis — Plan ${plan}`,
    external_reference: userId,
    payer_email: email,
    auto_recurring: {
      ...PLAN_FREQUENCY[plan],
      transaction_amount: amountCop,
      currency_id: 'COP',
    },
    back_url: backUrl,
  };
  if (cardToken) {
    body.card_token_id = cardToken;
    body.status = 'authorized';   // tarjeta tokenizada → activa sin redirect
  } else {
    body.status = 'pending';      // sin tarjeta → init_point
  }
  const data = await mpFetch('/preapproval', {
    method: 'POST',
    headers: {
      'X-Idempotency-Key': `cf-preapproval-${userId}-${attemptId}`,
    },
    body: JSON.stringify(body),
  });
  return { id: data.id, initPoint: data.init_point || null, amountCop, status: data.status };
}

// Relee el estado real de una suscripción desde MP (no confiamos en el payload
// del webhook: pedimos la verdad a la API con nuestro token).
export async function getPreapproval(id) {
  try {
    return await mpFetch(`/preapproval/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof MercadoPagoApiError && error.status === 404) return null;
    throw error;
  }
}

export async function getAuthorizedPayment(id) {
  try {
    return await mpFetch(`/authorized_payments/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof MercadoPagoApiError && error.status === 404) return null;
    throw error;
  }
}

export async function listAuthorizedPayments(preapprovalId) {
  const query = new URLSearchParams({ preapproval_id: String(preapprovalId), limit: '20', offset: '0' });
  const data = await mpFetch(`/authorized_payments/search?${query}`);
  return Array.isArray(data.results) ? data.results : [];
}

export async function getMercadoPagoPayment(id) {
  try {
    return await mpFetch(`/v1/payments/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof MercadoPagoApiError && error.status === 404) return null;
    throw error;
  }
}

// Mercado Pago tambien notifica los cobros de una suscripcion mediante el
// topic generico `payment`. En esos recursos el vinculo con el preapproval
// vive en metadata y/o point_of_interaction, no en el tipo del webhook.
export function mercadoPagoPaymentPreapprovalId(payment) {
  const value = payment?.metadata?.preapproval_id
    || payment?.point_of_interaction?.transaction_data?.subscription_id
    || null;
  return value ? String(value) : null;
}

// Respaldo de reconciliacion para cuentas donde /authorized_payments/search
// tarda en indexar (o no devuelve) una factura que ya aparece acreditada en
// Payments API. Siempre filtramos localmente por el preapproval real para que
// otro pago del mismo usuario nunca pueda activar esta compra.
export async function listMercadoPagoSubscriptionPayments(preapprovalId, userId, limit = 20) {
  if (!preapprovalId || !userId) return [];
  const query = new URLSearchParams({
    external_reference: String(userId),
    sort: 'date_created',
    criteria: 'desc',
    limit: String(Math.max(1, Math.min(50, Number(limit) || 20))),
  });
  const data = await mpFetch(`/v1/payments/search?${query}`);
  return (Array.isArray(data.results) ? data.results : []).filter(
    (payment) => mercadoPagoPaymentPreapprovalId(payment) === String(preapprovalId),
  );
}

export async function getMercadoPagoOrder(id) {
  try {
    return await mpFetch(`/v1/orders/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof MercadoPagoApiError && error.status === 404) return null;
    throw error;
  }
}

export async function cancelPreapproval(id) {
  const current = await getPreapproval(id);
  if (!current) throw new MercadoPagoApiError(`Mercado Pago preapproval not found: ${id}`, 404);
  if (['canceled', 'cancelled'].includes(current.status)) return current;
  return mpFetch(`/preapproval/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'X-Idempotency-Key': `cf-cancel-preapproval-${id}` },
    body: JSON.stringify({ status: 'canceled' }),
  });
}

export async function cancelMercadoPagoPayment(id, attemptId) {
  const payment = await getMercadoPagoPayment(id);
  if (!payment) return null;
  if (['cancelled', 'rejected', 'refunded', 'charged_back'].includes(payment.status)) return payment;
  if (payment.status === 'approved') {
    const error = new Error('Mercado Pago payment is already approved');
    error.code = 'PAYMENT_ALREADY_APPROVED';
    throw error;
  }
  return mpFetch(`/v1/payments/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {
      'X-Idempotency-Key': `cf-cancel-payment-${attemptId || id}`,
    },
    body: JSON.stringify({ status: 'cancelled' }),
  });
}

// Traduce el estado de MP al estado interno de user_profiles.
export function mpStatusToApp(mpStatus) {
  switch (mpStatus) {
    case 'authorized': return 'active';
    case 'paused':     return 'past_due';
    case 'cancelled':
    case 'canceled':   return 'cancelled';
    default:           return 'pending'; // pending u otros
  }
}

// ── Pago de UNA VEZ (PSE/Efecty) vía Payments API ────────────────────────────
// Los métodos de transferencia bancaria (PSE/Nequi) y efectivo (Efecty) NO se
// pueden cobrar de forma recurrente: son pago por periodo. Usamos /v1/payments
// (API nativa del Payment Brick). Para PSE, MP devuelve external_resource_url
// (URL del banco), paso final obligatorio del método. external_reference = userId
// para casar el pago con la cuenta en el webhook.
export async function createOrder({
  plan,
  formData,
  userId,
  email,
  backUrl,
  ipAddress,
  billingDetails,
  payerName,
  attemptId,
}) {
  if (!isValidPlan(plan)) throw new Error(`Plan inválido: ${plan}`);
  const amountCop = await planAmountCop(plan);
  if (!amountCop) throw new Error('No se pudo convertir el precio EUR→COP');

  const fd = formData || {};
  const payer = fd.payer || {};
  const pmId = fd.payment_method_id || fd.paymentMethodId;
  const financialInstitution =
    fd.transaction_details?.financial_institution
    || fd.financial_institution
    || payer.financial_institution;

  const details = billingDetails || {};
  // PSE exige first_name/last_name y el Brick no los recoge: caen al nombre del
  // perfil si el comprador no los escribio.
  const profileParts = String(payerName || '').trim().split(/\s+/).filter(Boolean);
  const firstName = String(details.firstName || payer.first_name || profileParts[0] || '').trim().slice(0, 32);
  const lastName = String(details.lastName || payer.last_name || profileParts.slice(1).join(' ') || '').trim().slice(0, 32);

  const payerBody = {
    email,
    entity_type: payer.entity_type || 'individual',
    first_name: firstName || undefined,
    last_name: lastName || undefined,
    identification: payer.identification,
  };
  if (pmId === 'pse') {
    const phone = String(details.phone || '').replace(/\D/g, '');
    payerBody.phone = { area_code: phone.slice(0, 3), number: phone.slice(3) };
    payerBody.address = {
      zip_code: String(details.zipCode || ''),
      street_name: String(details.streetName || '').trim(),
      street_number: String(details.streetNumber || '').trim(),
      neighborhood: String(details.neighborhood || '').trim(),
      city: String(details.city || '').trim(),
      // federal_unit figura como obligatorio en la spec de PSE; si el comprador
      // no lo indica lo omitimos en vez de mandar vacio (MP lo tolera hoy).
      ...(String(details.federalUnit || '').trim()
        ? { federal_unit: String(details.federalUnit).trim() }
        : {}),
    };
  } else if (payer.phone?.number) {
    // Nequi identifica al pagador por su celular: reenviamos tal cual lo entrega
    // el Brick, sin exigirle la direccion que solo pide PSE.
    payerBody.phone = {
      area_code: String(payer.phone.area_code || ''),
      number: String(payer.phone.number),
    };
  }

  const body = {
    transaction_amount: amountCop,
    description: `CF Análisis - Plan ${plan}`,
    payment_method_id: pmId,
    external_reference: userId,
    callback_url: backUrl,
    notification_url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://cfanalisis.com'}/api/mercadopago/webhook`,
    additional_info: { ip_address: ipAddress || '0.0.0.0' },
    ...(financialInstitution ? { transaction_details: { financial_institution: String(financialInstitution) } } : {}),
    payer: payerBody,
  };
  const data = await mpFetch('/v1/payments', {
    method: 'POST',
    headers: {
      'X-Idempotency-Key': `cf-payment-${userId}-${attemptId}`,
    },
    body: JSON.stringify(body),
  });
  const redirectUrl =
    data?.transaction_details?.external_resource_url
    || data?.point_of_interaction?.transaction_data?.ticket_url
    || null;
  return { id: data.id, status: data.status, redirectUrl, amountCop };
}

export function mercadoPagoPeriodEnd(plan, from = new Date()) {
  const cfg = PLANS[plan];
  if (!cfg) return null;
  return new Date(from.getTime() + cfg.intervalSeconds * 1000).toISOString();
}

// Verifica la firma del webhook de MP (x-signature) según la spec oficial.
//
// Manifest EXACTO (doc MP): `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
//   - <data.id> DEBE ser el valor del query param `data.id` de la URL de la
//     notificación (NO el id que venga en el body — ese era el bug que invalidaba
//     TODAS las firmas). En minúsculas si es alfanumérico (preapproval).
//   - <ts> y <v1> se extraen del header x-signature (`ts=...,v1=...`).
// HMAC-SHA256 hex con la clave secreta del webhook (panel MP → Webhooks).
//
// Devuelve true si valida; false si no valida. Sin secreto/firma → null (no se
// puede verificar criptográficamente → el caller decide; la seguridad real es
// la re-lectura del recurso vía API con nuestro token).
export function verifyWebhookSignature(request, dataIdFromQuery) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  const xSignature = request.headers.get('x-signature');
  const xRequestId = request.headers.get('x-request-id');
  if (!secret || !xSignature) return null; // no verificable → ver re-lectura API
  try {
    let ts;
    let v1;
    for (const part of xSignature.split(',')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (key === 'ts') ts = val;
      else if (key === 'v1') v1 = val;
    }
    if (!ts || !v1) return false;
    const rawId = String(dataIdFromQuery || '');
    // Regla MP: data.id alfanumérico va en minúsculas en el manifest.
    const id = /[A-Z]/.test(rawId) ? rawId.toLowerCase() : rawId;
    const manifest = `id:${id};request-id:${xRequestId};ts:${ts};`;
    const expected = createHmac('sha256', secret).update(manifest).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(v1, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
