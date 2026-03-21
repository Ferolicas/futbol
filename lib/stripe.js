import Stripe from 'stripe';

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
    firstMonthPrice: 1500,   // $15 (50% off)
    regularPrice: 3000,      // $30/month
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
    initialPrice: 10000,     // $100
    secondMonthPrice: 1500,  // $15 (50% off)
    regularPrice: 3000,      // $30/month
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

// COP prices (Colombian Peso) — fixed rates, update periodically
// 1 USD ≈ 4,200 COP (adjust as needed)
const PLANS_COP = {
  plataforma: { firstMonthPrice: 6200000, regularPrice: 12500000 }, // 62,000 / 125,000 COP (in centavos)
  asesoria:   { initialPrice: 41500000, secondMonthPrice: 6200000, regularPrice: 12500000 }, // 415,000 COP
};

// Create PSE payment in COP — returns clientSecret for PaymentElement (redirect flow)
export async function createPSEPayment({ plan, userId, email, name }) {
  if (!stripe) throw new Error('Stripe not configured');
  const planConfig = PLANS[plan];
  const copConfig = PLANS_COP[plan];
  if (!planConfig || !copConfig) throw new Error('Invalid plan');

  const metadata = { userId, plan, method: 'pse' };
  const customer = await getOrCreateCustomer(email, name, metadata);

  const amount = plan === 'plataforma' ? copConfig.firstMonthPrice : copConfig.initialPrice;

  const paymentIntent = await stripe.paymentIntents.create({
    amount,
    currency: 'cop',
    customer: customer.id,
    metadata,
    payment_method_types: ['pse'],
    setup_future_usage: 'off_session',
  });

  return {
    clientSecret: paymentIntent.client_secret,
    customerId: customer.id,
    amount,
    currency: 'cop',
    plan,
  };
}

// Create embedded payment — returns clientSecret for PaymentElement
// Both plans use PaymentIntent. Webhook creates subscriptions after payment.
export async function createEmbeddedPayment({ plan, userId, email, name }) {
  if (!stripe) throw new Error('Stripe not configured');

  const planConfig = PLANS[plan];
  if (!planConfig) throw new Error('Invalid plan');

  const metadata = { userId, plan };
  const customer = await getOrCreateCustomer(email, name, metadata);

  // Plataforma: $15 first month. Webhook creates $30/month subscription.
  // Asesoria: $100 initial. Webhook creates $30/month sub with 50% coupon on first invoice.
  const amount = plan === 'plataforma'
    ? planConfig.firstMonthPrice
    : planConfig.initialPrice;

  const paymentIntent = await stripe.paymentIntents.create({
    amount,
    currency: 'usd',
    customer: customer.id,
    metadata,
    automatic_payment_methods: { enabled: false },
    payment_method_types: ['card', 'amazon_pay'],
    setup_future_usage: 'off_session',
  });

  return {
    clientSecret: paymentIntent.client_secret,
    customerId: customer.id,
    amount,
    plan,
  };
}

// Create recurring subscription after initial payment
// Called by webhook after payment_intent.succeeded
export async function createPostPaymentSubscription(customerId, plan) {
  if (!stripe) throw new Error('Stripe not configured');

  const productId = await getOrCreateProduct(
    'Plan Plataforma',
    'Acceso mensual a la plataforma'
  );

  const subParams = {
    customer: customerId,
    items: [
      {
        price_data: {
          currency: 'usd',
          product: productId,
          unit_amount: PLANS.plataforma.regularPrice,
          recurring: { interval: 'month' },
        },
      },
    ],
    trial_period_days: 30,
    metadata: { plan },
    default_payment_method: await getDefaultPaymentMethod(customerId),
  };

  // Asesoria: 50% off on first subscription invoice (month 2 = $15)
  if (plan === 'asesoria') {
    const couponId = process.env.STRIPE_COUPON_50_ID;
    if (couponId) {
      subParams.discounts = [{ coupon: couponId }];
    }
  }

  return stripe.subscriptions.create(subParams);
}

// Get the customer's most recent payment method
async function getDefaultPaymentMethod(customerId) {
  const methods = await stripe.paymentMethods.list({
    customer: customerId,
    type: 'card',
    limit: 1,
  });
  return methods.data[0]?.id || undefined;
}
