import Stripe from 'stripe';
import { convertAmount } from './currency';

// Stripe zero-decimal currencies (amounts passed as-is, no *100)
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF',
]);

// Server-side Stripe instance
export const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
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

// Plan configuration — prices in USD cents.
// Cada plan es una suscripción Stripe que se cobra al final del periodo.
export const PLANS = {
  semanal: {
    name: 'Plan Semanal',
    description: PLATFORM_DESCRIPTION,
    features: PLATFORM_FEATURES,
    price: 700,        // $7 USD
    interval: 'week',
    intervalCount: 1,
    intervalSeconds: 7 * 24 * 3600,
    label: '/ semana',
    currency: 'usd',
  },
  mensual: {
    name: 'Plan Mensual',
    description: PLATFORM_DESCRIPTION,
    features: PLATFORM_FEATURES,
    price: 1500,       // $15 USD
    interval: 'month',
    intervalCount: 1,
    intervalSeconds: 30 * 24 * 3600,
    label: '/ mes',
    currency: 'usd',
  },
  trimestral: {
    name: 'Plan Trimestral',
    description: PLATFORM_DESCRIPTION,
    features: PLATFORM_FEATURES,
    price: 3500,       // $35 USD
    interval: 'month',
    intervalCount: 3,
    intervalSeconds: 90 * 24 * 3600,
    label: '/ 3 meses',
    currency: 'usd',
  },
  semestral: {
    name: 'Plan Semestral',
    description: PLATFORM_DESCRIPTION,
    features: PLATFORM_FEATURES,
    price: 8000,       // $80 USD
    interval: 'month',
    intervalCount: 6,
    intervalSeconds: 180 * 24 * 3600,
    label: '/ 6 meses',
    currency: 'usd',
  },
  anual: {
    name: 'Plan Anual',
    description: PLATFORM_DESCRIPTION,
    features: PLATFORM_FEATURES,
    price: 7000,       // $70 USD
    interval: 'year',
    intervalCount: 1,
    intervalSeconds: 365 * 24 * 3600,
    label: '/ año',
    currency: 'usd',
  },
};

export const PLAN_IDS = Object.keys(PLANS);
export const isValidPlan = (id) => Object.prototype.hasOwnProperty.call(PLANS, id);

// Get or create a Stripe customer by email
async function getOrCreateCustomer(email, name, metadata) {
  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data.length > 0) return existing.data[0];
  return stripe.customers.create({ email, name, metadata });
}

// Get or create a Stripe product by name
async function getOrCreateProduct(name, description) {
  const products = await stripe.products.list({ active: true, limit: 100 });
  const existing = products.data.find(p => p.name === name);
  if (existing) return existing.id;
  const product = await stripe.products.create({ name, description });
  return product.id;
}

// Create embedded payment — returns clientSecret for PaymentElement.
// Cobra el primer periodo en USD (o moneda local equivalente). El webhook
// crea la suscripción recurrente para que se cobre automáticamente al
// final de cada periodo (semana, mes, 3 meses, 6 meses o año).
export async function createEmbeddedPayment({ plan, userId, email, name, currency = 'USD' }) {
  if (!stripe) throw new Error('Stripe not configured');

  const planConfig = PLANS[plan];
  if (!planConfig) throw new Error('Invalid plan');

  const metadata = { userId, plan };
  const customer = await getOrCreateCustomer(email, name, metadata);

  const usdAmount = planConfig.price / 100;
  const targetCurrency = currency.toUpperCase();

  let stripeAmount;
  let stripeCurrency;

  if (targetCurrency === 'USD') {
    stripeAmount = Math.round(usdAmount * 100);
    stripeCurrency = 'usd';
  } else {
    const { amount: localAmount } = await convertAmount(usdAmount, targetCurrency);
    stripeAmount = ZERO_DECIMAL_CURRENCIES.has(targetCurrency)
      ? Math.round(localAmount)
      : Math.round(localAmount * 100);
    stripeCurrency = targetCurrency.toLowerCase();
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: stripeAmount,
    currency: stripeCurrency,
    customer: customer.id,
    metadata,
    automatic_payment_methods: { enabled: true },
    setup_future_usage: 'off_session',
  });

  return {
    clientSecret: paymentIntent.client_secret,
    customerId: customer.id,
    amount: stripeAmount,
    currency: stripeCurrency,
    plan,
  };
}

// Create recurring subscription after initial payment.
// Llamada por el webhook tras `payment_intent.succeeded`.
// El siguiente cobro se ancla exactamente al final del periodo del plan
// (firstPayment + intervalSeconds).
export async function createPostPaymentSubscription(customerId, plan, paymentMethodId, firstPaymentUnix) {
  if (!stripe) throw new Error('Stripe not configured');

  const planConfig = PLANS[plan];
  if (!planConfig) throw new Error(`Unknown plan: ${plan}`);

  // Attach PM to customer and set as default — required for automatic renewals.
  if (paymentMethodId) {
    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    } catch (e) {
      if (e.code !== 'resource_already_exists') throw e;
    }
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  }

  const productId = await getOrCreateProduct(planConfig.name, planConfig.description);

  const nowSec = Math.floor(Date.now() / 1000);
  const anchor = (firstPaymentUnix || nowSec) + planConfig.intervalSeconds;
  // Anchor must be in the future; if first payment was longer ago than the
  // period, push to nowSec + intervalSeconds.
  const billingCycleAnchor = anchor > nowSec ? anchor : nowSec + planConfig.intervalSeconds;

  return stripe.subscriptions.create({
    customer: customerId,
    items: [{
      price_data: {
        currency: 'usd',
        product: productId,
        unit_amount: planConfig.price,
        recurring: {
          interval: planConfig.interval,
          interval_count: planConfig.intervalCount,
        },
      },
    }],
    billing_cycle_anchor: billingCycleAnchor,
    proration_behavior: 'none',
    default_payment_method: paymentMethodId,
    metadata: { plan },
  });
}
