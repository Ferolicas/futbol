import Stripe from 'stripe';
import { convertAmount } from './currency';

// Stripe zero-decimal currencies (amounts passed as-is, no *100). UGX no va
// aqui: para cargos Stripe conserva compatibilidad de dos decimales (*100).
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','VND','VUV','XAF','XOF','XPF',
]);

// Server-side Stripe instance
export const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, {
      maxNetworkRetries: 2,
      timeout: 20_000,
    })
  : null;

// Descripción única de la plataforma (compartida por los 5 planes)
const PLATFORM_DESCRIPTION = 'Acceso total a estadisticas, analisis y herramientas de apuesta';
const PLATFORM_FEATURES = [
  'Analisis estadistico completo',
  'Apuesta del Dia inteligente',
  'Combinadas automaticas',
  'Marcadores en vivo',
  '15+ ligas internacionales',
  'Corners, tarjetas, BTTS',
];

// Plan configuration — precios de REFERENCIA en EUR (céntimos).
// El euro es la moneda de referencia única (acordado 2026-06): cada país ve y
// paga el equivalente convertido en vivo (open.er-api.com, sin key). Stripe
// (mundo) convierte EUR→moneda local; Mercado Pago (Colombia) convierte EUR→COP
// (ver lib/mercadopago.js). Cada plan se cobra al final del periodo.
export const PLANS = {
  semanal: {
    name: 'Plan Semanal',
    description: PLATFORM_DESCRIPTION,
    features: PLATFORM_FEATURES,
    price: 600,        // 6 EUR
    interval: 'week',
    intervalCount: 1,
    intervalSeconds: 7 * 24 * 3600,
    label: '/ semana',
    currency: 'eur',
  },
  mensual: {
    name: 'Plan Mensual',
    description: PLATFORM_DESCRIPTION,
    features: PLATFORM_FEATURES,
    price: 1500,       // 15 EUR
    interval: 'month',
    intervalCount: 1,
    intervalSeconds: 30 * 24 * 3600,
    label: '/ mes',
    currency: 'eur',
  },
  trimestral: {
    name: 'Plan Trimestral',
    description: PLATFORM_DESCRIPTION,
    features: PLATFORM_FEATURES,
    price: 3500,       // 35 EUR
    interval: 'month',
    intervalCount: 3,
    intervalSeconds: 90 * 24 * 3600,
    label: '/ 3 meses',
    currency: 'eur',
  },
  semestral: {
    name: 'Plan Semestral',
    description: PLATFORM_DESCRIPTION,
    features: PLATFORM_FEATURES,
    price: 7000,       // 70 EUR
    interval: 'month',
    intervalCount: 6,
    intervalSeconds: 180 * 24 * 3600,
    label: '/ 6 meses',
    currency: 'eur',
  },
  anual: {
    name: 'Plan Anual',
    description: PLATFORM_DESCRIPTION,
    features: PLATFORM_FEATURES,
    price: 10000,      // 100 EUR (precio definitivo con descuento)
    originalPrice: 12000, // 120 EUR (precio sin descuento, solo display)
    interval: 'year',
    intervalCount: 1,
    intervalSeconds: 365 * 24 * 3600,
    label: '/ año',
    currency: 'eur',
  },
};

export const PLAN_IDS = Object.keys(PLANS);
export const isValidPlan = (id) => Object.prototype.hasOwnProperty.call(PLANS, id);

// Obtiene primero el customer guardado. Si pertenece a una cuenta Stripe vieja
// (resource_missing), busca por email en la cuenta LIVE actual y finalmente crea
// uno nuevo. Esto permite migrar de cuenta sin entregar al cliente un ID huerfano.
async function getOrCreateCustomer({ email, name, userId, storedCustomerId }) {
  if (storedCustomerId) {
    try {
      const stored = await stripe.customers.retrieve(storedCustomerId);
      if (stored && !stored.deleted) {
        if (stored.metadata?.userId !== userId || stored.email !== email || stored.name !== name) {
          return stripe.customers.update(stored.id, {
            email,
            name: name || undefined,
            metadata: { ...(stored.metadata || {}), userId },
          });
        }
        return stored;
      }
    } catch (error) {
      if (error.code !== 'resource_missing') throw error;
    }
  }

  const existing = await stripe.customers.list({ email, limit: 10 });
  const exact = existing.data.find((customer) => customer.metadata?.userId === userId)
    || existing.data[0];
  if (exact) {
    return stripe.customers.update(exact.id, {
      email,
      name: name || undefined,
      metadata: { ...(exact.metadata || {}), userId },
    });
  }
  return stripe.customers.create({
    email,
    name: name || undefined,
    metadata: { userId },
  }, { idempotencyKey: `cf-customer:${userId}` });
}

// R5 FIX: cache por-proceso de product_id por nombre. Los productos de Stripe son
// estables (5 planes); antes se hacía products.list(limit:100) + find en CADA alta
// de suscripción (llamada extra a Stripe + frágil ante colisión de nombres).
const _productIdCache = new Map();

// Get or create a Stripe product by name
async function getOrCreateProduct(name, description) {
  if (_productIdCache.has(name)) return _productIdCache.get(name);
  const products = await stripe.products.list({ active: true, limit: 100 });
  const existing = products.data.find(p => p.name === name);
  const id = existing
    ? existing.id
    : (await stripe.products.create(
        { name, description },
        { idempotencyKey: `cf-product:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` },
      )).id;
  _productIdCache.set(name, id);
  return id;
}

async function stripeAmountForPlan(planConfig, currency) {
  const sourceCurrency = (planConfig.currency || 'eur').toUpperCase();
  const sourceAmount = planConfig.price / 100;
  const targetCurrency = String(currency || sourceCurrency).toUpperCase();

  if (!/^[A-Z]{3}$/.test(targetCurrency)) throw new Error('Invalid currency');
  if (targetCurrency === sourceCurrency) {
    return {
      amount: ZERO_DECIMAL_CURRENCIES.has(targetCurrency)
        ? Math.round(sourceAmount)
        : Math.round(sourceAmount * 100),
      currency: targetCurrency.toLowerCase(),
    };
  }

  const conv = await convertAmount(sourceAmount, targetCurrency, sourceCurrency);
  const chargeCurrency = (conv.currency || sourceCurrency).toUpperCase();
  return {
    amount: ZERO_DECIMAL_CURRENCIES.has(chargeCurrency)
      ? Math.round(conv.amount)
      : Math.round(conv.amount * 100),
    currency: chargeCurrency.toLowerCase(),
  };
}

function expandedInvoice(subscription) {
  return subscription?.latest_invoice && typeof subscription.latest_invoice === 'object'
    ? subscription.latest_invoice
    : null;
}

async function subscriptionClientSecret(subscription) {
  let invoice = expandedInvoice(subscription);
  if (!invoice && subscription?.latest_invoice) {
    invoice = await stripe.invoices.retrieve(subscription.latest_invoice, {
      expand: ['confirmation_secret'],
    });
  }
  return invoice?.confirmation_secret?.client_secret || null;
}

export function stripeSubscriptionPeriodEnd(subscription) {
  const ends = (subscription?.items?.data || [])
    .map((item) => Number(item.current_period_end || 0))
    .filter((value) => value > 0);
  if (!ends.length) return null;
  return new Date(Math.min(...ends) * 1000).toISOString();
}

export function stripeSubscriptionAppStatus(subscription) {
  if (['active', 'trialing'].includes(subscription?.status)) return 'active';
  if (['past_due', 'unpaid', 'paused'].includes(subscription?.status)) return 'past_due';
  if (['canceled', 'incomplete_expired'].includes(subscription?.status)) return 'cancelled';
  return 'pending';
}

export function stripeInvoiceSubscriptionId(invoice) {
  const parentSubscription = invoice?.parent?.subscription_details?.subscription;
  if (typeof parentSubscription === 'string') return parentSubscription;
  if (parentSubscription?.id) return parentSubscription.id;
  // Compatibilidad con eventos creados bajo una version anterior de la API.
  if (typeof invoice?.subscription === 'string') return invoice.subscription;
  return invoice?.subscription?.id || null;
}

/**
 * Crea la suscripcion ANTES de cobrar. La primera factura queda incomplete y su
 * PaymentIntent se confirma con PaymentElement. Una confirmacion exitosa activa
 * la misma suscripcion que renovara: ya no existe el hueco "cobrado pero sin
 * recurrencia" del flujo PaymentIntent -> webhook -> subscriptions.create.
 */
export async function createEmbeddedSubscription({
  plan,
  userId,
  email,
  name,
  currency = 'EUR',
  storedCustomerId = null,
  attemptId,
}) {
  if (!stripe) throw new Error('Stripe not configured');

  const planConfig = PLANS[plan];
  if (!planConfig) throw new Error('Invalid plan');
  const customer = await getOrCreateCustomer({ email, name, userId, storedCustomerId });
  const charge = await stripeAmountForPlan(planConfig, currency);
  const productId = await getOrCreateProduct(planConfig.name, planConfig.description);
  const metadata = { userId, plan, checkoutAttemptId: attemptId };

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{
      price_data: {
        currency: charge.currency,
        product: productId,
        unit_amount: charge.amount,
        recurring: {
          interval: planConfig.interval,
          interval_count: planConfig.intervalCount,
        },
      },
    }],
    payment_behavior: 'default_incomplete',
    payment_settings: {
      save_default_payment_method: 'on_subscription',
      // Solo metodos capaces de renovar con charge_automatically.
      payment_method_types: ['card', 'link'],
    },
    billing_mode: { type: 'flexible' },
    metadata,
    expand: ['latest_invoice.confirmation_secret'],
  }, { idempotencyKey: `cf-subscription:${userId}:${attemptId}` });

  const clientSecret = await subscriptionClientSecret(subscription);
  if (!clientSecret && !['active', 'trialing'].includes(subscription.status)) {
    throw new Error('Stripe subscription has no confirmation secret');
  }

  return {
    clientSecret,
    customerId: customer.id,
    subscriptionId: subscription.id,
    status: subscription.status,
    amount: charge.amount,
    currency: charge.currency,
    plan,
  };
}

export async function retrieveEmbeddedSubscription(subscriptionId) {
  if (!stripe) throw new Error('Stripe not configured');
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['latest_invoice.confirmation_secret'],
  });
  return {
    subscription,
    clientSecret: await subscriptionClientSecret(subscription),
  };
}

export async function cancelStripeSubscription(subscriptionId, atPeriodEnd = false) {
  if (!stripe) throw new Error('Stripe not configured');
  const current = await stripe.subscriptions.retrieve(subscriptionId);
  if (current.status === 'canceled') return current;
  if (atPeriodEnd) {
    if (current.cancel_at_period_end) return current;
    return stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  }
  return stripe.subscriptions.cancel(subscriptionId);
}
