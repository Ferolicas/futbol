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
import { createHmac } from 'crypto';
import { PLANS } from './stripe';
import { convertAmount } from './currency';

const MP_API = 'https://api.mercadopago.com';

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
  if (conv.fallback || conv.currency !== 'COP' || !(conv.amount > 0)) return null;
  return Math.round(conv.amount);
}

// Crea una suscripción (preapproval) recurrente. El monto en COP queda fijado a
// la tasa del día.
//   - CON cardToken (modal embebido, Card Brick): status 'authorized' → queda
//     activa de inmediato, SIN redirigir. Es el flujo por defecto.
//   - SIN cardToken (fallback): status 'pending' → devuelve init_point (checkout
//     alojado de MP) por si alguna vez se quiere el flujo redirigido.
export async function createPreapproval({ plan, email, userId, backUrl, cardToken }) {
  if (!isValidPlan(plan)) throw new Error(`Plan inválido: ${plan}`);
  const amountCop = await planAmountCop(plan);
  if (!amountCop) throw new Error('No se pudo convertir el precio EUR→COP');

  const body = {
    reason: `CF Análisis — Plan ${plan}`,
    external_reference: userId,        // ← clave para enlazar el pago con la cuenta
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

  const res = await fetch(`${MP_API}/preapproval`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mpAccessToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`MP preapproval ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { id: data.id, initPoint: data.init_point || null, amountCop, status: data.status };
}

// Relee el estado real de una suscripción desde MP (no confiamos en el payload
// del webhook: pedimos la verdad a la API con nuestro token).
export async function getPreapproval(id) {
  const res = await fetch(`${MP_API}/preapproval/${id}`, {
    headers: { Authorization: `Bearer ${mpAccessToken()}` },
  });
  return res.ok ? res.json() : null;
}

// Traduce el estado de MP al estado interno de user_profiles.
export function mpStatusToApp(mpStatus) {
  switch (mpStatus) {
    case 'authorized': return 'active';
    case 'paused':     return 'past_due';
    case 'cancelled':  return 'cancelled';
    default:           return 'pending'; // pending u otros
  }
}

// ── Pago de UNA VEZ (PSE/Efecty) vía Payments API ────────────────────────────
// Los métodos de transferencia bancaria (PSE/Nequi) y efectivo (Efecty) NO se
// pueden cobrar de forma recurrente: son pago por periodo. Usamos /v1/payments
// (API nativa del Payment Brick). Para PSE, MP devuelve external_resource_url
// (URL del banco), paso final obligatorio del método. external_reference = userId
// para casar el pago con la cuenta en el webhook.
export async function createOrder({ plan, formData, userId, backUrl, ipAddress }) {
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

  const body = {
    transaction_amount: amountCop,
    description: `CF Análisis - Plan ${plan}`,
    payment_method_id: pmId,
    external_reference: userId,
    callback_url: backUrl,
    notification_url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://cfanalisis.com'}/api/mercadopago/webhook`,
    additional_info: { ip_address: ipAddress || '0.0.0.0' },
    ...(financialInstitution ? { transaction_details: { financial_institution: String(financialInstitution) } } : {}),
    payer: {
      email: payer.email,
      entity_type: payer.entity_type || 'individual',
      identification: payer.identification,
      ...(payer.address ? { address: payer.address } : {
        address: { zip_code: '110111', street_name: 'N/A', street_number: 'S/N', neighborhood: 'Centro', city: 'Bogota' },
      }),
    },
  };

  const res = await fetch(`${MP_API}/v1/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mpAccessToken()}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `${userId}-${Date.now()}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`MP payment ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const redirectUrl =
    data?.transaction_details?.external_resource_url
    || data?.point_of_interaction?.transaction_data?.ticket_url
    || null;
  return { id: data.id, status: data.status, redirectUrl, amountCop };
}

// Verifica la firma del webhook de MP (x-signature) con el secreto configurado.
// Devuelve true si es válida o si no hay secreto/firma (en cuyo caso confiamos en
// la re-lectura del recurso vía API, que también es segura).
export function verifyWebhookSignature(request, dataId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  const xSignature = request.headers.get('x-signature');
  const xRequestId = request.headers.get('x-request-id');
  if (!secret || !xSignature) return true; // sin firma → seguridad por re-lectura
  try {
    const parts = Object.fromEntries(
      xSignature.split(',').map((kv) => kv.split('=').map((s) => s.trim())),
    );
    const ts = parts.ts;
    const v1 = parts.v1;
    if (!ts || !v1) return false;
    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const hmac = createHmac('sha256', secret).update(manifest).digest('hex');
    return hmac === v1;
  } catch {
    return false;
  }
}
