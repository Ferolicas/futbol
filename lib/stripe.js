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
    // Month 1: $15 (50% discount), Month 2+: $30
    firstMonthPrice: 1500,   // cents
    regularPrice: 3000,      // cents
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
    // Initial: $100 (asesoria 1 mes + plataforma), Month 2: $15 (50%), Month 3+: $30
    initialPrice: 10000,     // cents
    secondMonthPrice: 1500,  // cents
    regularPrice: 3000,      // cents
    currency: 'usd',
  },
};

// Get or create a Stripe customer by email
async function getOrCreateCustomer(email, name, metadata) {
  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data.length > 0) return existing.data[0];
  return stripe.customers.create({ email, name, metadata });
}

// Get or create a Stripe product by name (avoids duplicates)
async function getOrCreateProduct(name, description) {
  const products = await stripe.products.list({ active: true, limit: 100 });
  const existing = products.data.find(p => p.name === name);
  if (existing) return existing.id;
  const product = await stripe.products.create({ name, description });
  return product.id;
}

// Create embedded payment intent — returns clientSecret for PaymentElement
export async function createEmbeddedPayment({ plan, userId, email, name }) {
  if (!stripe) throw new Error('Stripe not configured');

  const planConfig = PLANS[plan];
  if (!planConfig) throw new Error('Invalid plan');

  const couponId = process.env.STRIPE_COUPON_50_ID;
  if (!couponId) throw new Error('STRIPE_COUPON_50_ID is required');

  const metadata = { userId, plan };
  const customer = await getOrCreateCustomer(email, name, metadata);

  if (plan === 'plataforma') {
    const productId = await getOrCreateProduct(planConfig.name, planConfig.description);

    // Subscription: $15 first month (50% coupon), then $30/month
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [
        {
          price_data: {
            currency: 'usd',
            product: productId,
            unit_amount: planConfig.regularPrice,
            recurring: { interval: 'month' },
          },
        },
      ],
      discounts: [{ coupon: couponId }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        payment_method_types: ['card', 'amazon_pay'],
        save_default_payment_method: 'on_subscription',
      },
      metadata,
      expand: ['latest_invoice.payment_intent'],
    });

    return {
      clientSecret: subscription.latest_invoice.payment_intent.client_secret,
      customerId: customer.id,
      subscriptionId: subscription.id,
      amount: planConfig.firstMonthPrice,
      plan,
    };
  }

  if (plan === 'asesoria') {
    // One-time $100 payment. Webhook creates subscription after.
    const paymentIntent = await stripe.paymentIntents.create({
      amount: planConfig.initialPrice,
      currency: 'usd',
      customer: customer.id,
      metadata,
      automatic_payment_methods: { enabled: false },
      payment_method_types: ['card', 'amazon_pay'],
    });

    return {
      clientSecret: paymentIntent.client_secret,
      customerId: customer.id,
      amount: planConfig.initialPrice,
      plan,
    };
  }
}

// Create subscription after asesoria initial $100 payment
// Month 1 covered by payment → 30-day trial
// Month 2: $15 (50% coupon) → Month 3+: $30/month
export async function createAsesoriaSubscription(customerId) {
  if (!stripe) throw new Error('Stripe not configured');

  const couponId = process.env.STRIPE_COUPON_50_ID;
  if (!couponId) throw new Error('STRIPE_COUPON_50_ID is required');

  const productId = await getOrCreateProduct(
    'Plan Plataforma (Post-Asesoria)',
    'Acceso mensual a la plataforma'
  );

  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [
      {
        price_data: {
          currency: 'usd',
          product: productId,
          unit_amount: PLANS.asesoria.regularPrice,
          recurring: { interval: 'month' },
        },
      },
    ],
    trial_period_days: 30,
    discounts: [{ coupon: couponId }],
    metadata: { plan: 'asesoria' },
  });

  return subscription;
}
