// ─────────────────────────────────────────────────────────────────────────────
// lib/hotmart.js — Integración con Hotmart (pagos LATAM + suscripción recurrente).
//
// Reemplaza el checkout embebido de Stripe. El flujo es:
//   1. El usuario elige plan en /planes → redirige al link de checkout de la
//      oferta de Hotmart correspondiente, con su email + userId (sck) para poder
//      reconocerlo después.
//   2. Hotmart cobra y gestiona la suscripción recurrente automática.
//   3. Hotmart llama a /api/hotmart/webhook → activamos/cancelamos el plan en
//      user_profiles según el evento.
//
// Los códigos de oferta NO son secretos (viven en las URLs públicas de checkout).
// El único secreto es HOTMART_HOTTOK, que solo se usa server-side en el webhook.
// ─────────────────────────────────────────────────────────────────────────────

export const HOTMART_PRODUCT = 'T106297120M';
// Checkout COMPLETO de Hotmart (pay.hotmart.com, no la página de ventas
// go.hotmart.com). Deliberadamente SIN checkoutMode=2 (el modo popup/embebido):
// ese modo oculta los métodos locales que redirigen al banco (PSE, Nequi, etc.).
// El checkout completo muestra TODOS los métodos de pago de cada país.
export const HOTMART_CHECKOUT_BASE = `https://pay.hotmart.com/${HOTMART_PRODUCT}`;

// Plan interno (el mismo id que usaba Stripe) → código de oferta de Hotmart.
export const PLAN_TO_OFFER = {
  semanal:    'awwout5f',
  mensual:    'zygscq59',
  trimestral: '14ur6t4r',
  semestral:  'zwq5sui3',
  anual:      'kw5jrh74',
};

// Inverso: código de oferta → plan interno (lo usa el webhook).
export const OFFER_TO_PLAN = Object.fromEntries(
  Object.entries(PLAN_TO_OFFER).map(([plan, off]) => [off, plan]),
);

export const isValidPlan = (plan) =>
  Object.prototype.hasOwnProperty.call(PLAN_TO_OFFER, plan);

// Construye el link de checkout de Hotmart para un plan, con prefill de email/
// nombre y tracking sck=userId (vuelve en el webhook para enlazar el pago con
// la cuenta de CF Análisis aunque el comprador use otro email).
export function hotmartCheckoutUrl(plan, { email, name, userId } = {}) {
  const off = PLAN_TO_OFFER[plan];
  if (!off) return null;
  const u = new URL(HOTMART_CHECKOUT_BASE);
  u.searchParams.set('off', off);
  if (email) u.searchParams.set('email', email);
  if (name) u.searchParams.set('name', name);
  if (userId) u.searchParams.set('sck', userId);
  return u.toString();
}

// ── Helpers del webhook (server-side) ────────────────────────────────────────

// Eventos de Hotmart que ACTIVAN el acceso.
const ACTIVATE_EVENTS = new Set(['PURCHASE_APPROVED', 'PURCHASE_COMPLETE']);
// Eventos que CORTAN el acceso (reembolso, contracargo, cancelación, expiración).
const DEACTIVATE_EVENTS = new Set([
  'PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK', 'PURCHASE_PROTEST',
  'PURCHASE_EXPIRED', 'PURCHASE_CANCELED', 'SUBSCRIPTION_CANCELLATION',
]);

export function classifyHotmartEvent(eventName) {
  if (ACTIVATE_EVENTS.has(eventName)) return 'activate';
  if (DEACTIVATE_EVENTS.has(eventName)) return 'deactivate';
  if (eventName === 'PURCHASE_DELAYED') return 'past_due';
  if (eventName === 'SWITCH_PLAN') return 'switch';
  return 'ignore';
}

// Extrae los campos que nos importan del payload, tolerando variaciones de
// estructura entre versiones del webhook (lee varias rutas posibles).
export function extractHotmartFields(payload) {
  const data = payload?.data || payload || {};
  const buyer = data.buyer || data.subscriber || {};
  const purchase = data.purchase || {};
  const subscription = data.subscription || {};
  const offerCode = purchase.offer?.code || subscription.plan?.offer?.code
    || data.offer?.code || null;
  const tracking = purchase.tracking || data.tracking || {};
  const sck = tracking.source_sck || tracking.sck || tracking.source || null;
  return {
    email: (buyer.email || data.email || '').toLowerCase().trim() || null,
    name: buyer.name || data.name || null,
    offerCode,
    plan: offerCode ? (OFFER_TO_PLAN[offerCode] || null) : null,
    sck,
    transaction: purchase.transaction || data.transaction || null,
    subscriberCode: subscription.subscriber?.code || data.subscriber?.code || null,
  };
}
