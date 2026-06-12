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

// Crea una suscripción (preapproval) recurrente con tarjeta. Devuelve el
// init_point (checkout alojado de MP) al que se redirige al cliente para
// autorizarla. El monto en COP queda fijado a la tasa de hoy.
export async function createPreapproval({ plan, email, userId, backUrl }) {
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
    status: 'pending',
  };

  const res = await fetch(`${MP_API}/preapproval`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mpAccessToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.init_point) {
    throw new Error(`MP preapproval ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { id: data.id, initPoint: data.init_point, amountCop };
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
