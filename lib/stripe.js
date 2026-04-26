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

// Plan configuration — prices in USD cents
export const PLANS = {
  plataforma: {
    name: 'Plan Plataforma',
    description: 'Acceso total a estadisticas, analisis y herramientas de apuesta',
    features: [
      'Analisis estadistico completo',
      'Apuesta del Dia inteligente',
      'Combinadas automaticas',
      'Marcadores en vivo',
      '15+ ligas internacionales',
      'Corners, tarjetas, BTTS',
    ],
    firstMonthPrice: 1500,   // $15/month (flat rate)
    regularPrice: 1500,      // $15/month
    currency: 'usd',
  },
  asesoria: {
    name: 'Plan Asesoria',
    description: 'Formacion en apuestas, estrategias, bankroll + acceso total a plataforma',
    features: [
      'Todo lo del Plan Plataforma',
      'Formacion personalizada en apuestas',
      'Estrategias de bankroll management',
      'Soporte prioritario 1 a 1',
      'Sesiones de asesoria mensual',
      'Acceso a comunidad VIP',
    ],
    initialPrice: 5000,      // $50 one-time upfront
    secondMonthPrice: 1500,  // $15/month recurring
    regularPrice: 1500,      // $15/month
    currency: 'usd',
  },
};

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

// Create embedded payment — returns clientSecret for PaymentElement
// Both plans use PaymentIntent. Webhook creates subscriptions after payment.
// currency: ISO 4217 code (e.g. 'COP', 'EUR', 'USD') from the visitor's country
export async function createEmbeddedPayment({ plan, userId, email, name, currency = 'USD' }) {
  if (!stripe) throw new Error('Stripe not configured');

  const planConfig = PLANS[plan];
  if (!planConfig) throw new Error('Invalid plan');

  const metadata = { userId, plan };
  const customer = await getOrCreateCustomer(email, name, metadata);

  const usdAmount = (plan === 'plataforma' ? planConfig.firstMonthPrice : planConfig.initialPrice) / 100;
  const targetCurrency = currency.toUpperCase();

  let stripeAmount;
  let stripeCurrency;

  if (targetCurrency === 'USD') {
    stripeAmount = Math.round(usdAmount * 100); // USD cents
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

// Create recurring subscription after initial payment
// Called by webhook after payment_intent.succeeded.
// paymentMethodId: PM used in the PaymentIntent (pi.payment_method) — attaches it to
//   the customer and uses it for future renewals.
// firstPaymentUnix: pi.created — anchors the next billing cycle exactly 30 days later.
export async function createPostPaymentSubscription(customerId, plan, paymentMethodId, firstPaymentUnix) {
  if (!stripe) throw new Error('Stripe not configured');

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

  const productName = plan === 'asesoria' ? 'Plan Asesoria' : 'Plan Plataforma';
  const productId = await getOrCreateProduct(productName, 'Acceso mensual a la plataforma');

  const nowSec = Math.floor(Date.now() / 1000);
  const anchor = (firstPaymentUnix || nowSec) + 30 * 24 * 3600;
  // Anchor must be in the future; if first payment was >30d ago, push to nowSec+30d.
  const billingCycleAnchor = anchor > nowSec ? anchor : nowSec + 30 * 24 * 3600;

  return stripe.subscriptions.create({
    customer: customerId,
    items: [{
      price_data: {
        currency: 'usd',
        product: productId,
        unit_amount: PLANS.plataforma.regularPrice,
        recurring: { interval: 'month' },
      },
    }],
    billing_cycle_anchor: billingCycleAnchor,
    proration_behavior: 'none',
    default_payment_method: paymentMethodId,
    metadata: { plan },
  });
}
