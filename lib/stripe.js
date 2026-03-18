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

// Create Stripe checkout session
export async function createCheckoutSession({ plan, userId, email, name, successUrl, cancelUrl, localCurrency, exchangeRate }) {
  if (!stripe) throw new Error('Stripe not configured');

  const planConfig = PLANS[plan];
  if (!planConfig) throw new Error('Invalid plan');

  const metadata = {
    userId,
    plan,
    localCurrency: localCurrency || 'usd',
    exchangeRate: exchangeRate ? String(exchangeRate) : '1',
  };

  if (plan === 'plataforma') {
    // Create a subscription with introductory pricing
    // Phase 1: $15 first month via coupon, then $30/month
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      metadata,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: planConfig.name,
              description: planConfig.description,
            },
            unit_amount: planConfig.regularPrice,
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ],
      subscription_data: {
        metadata,
        trial_period_days: 0,
      },
      discounts: process.env.STRIPE_COUPON_50_ID
        ? [{ coupon: process.env.STRIPE_COUPON_50_ID }]
        : [],
      success_url: successUrl || `${process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000'}/dashboard?checkout=success`,
      cancel_url: cancelUrl || `${process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000'}/?checkout=cancelled`,
      allow_promotion_codes: true,
    });

    return session;
  }

  if (plan === 'asesoria') {
    // Initial $100 payment + subscription setup
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      metadata,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${planConfig.name} - Pago Inicial`,
              description: 'Asesoria 1 mes + Acceso a Plataforma',
            },
            unit_amount: planConfig.initialPrice,
          },
          quantity: 1,
        },
      ],
      success_url: successUrl || `${process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000'}/dashboard?checkout=success&plan=asesoria`,
      cancel_url: cancelUrl || `${process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000'}/?checkout=cancelled`,
    });

    return session;
  }
}

// Create subscription after asesoria initial payment
export async function createAsesoriaSubscription(customerId) {
  if (!stripe) throw new Error('Stripe not configured');

  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Plan Plataforma (Post-Asesoria)',
            description: 'Acceso mensual a la plataforma',
          },
          unit_amount: PLANS.asesoria.regularPrice,
          recurring: { interval: 'month' },
        },
      },
    ],
    // Second month is $15 (50% off), then $30
    trial_period_days: 30, // First month covered by initial payment
    metadata: { plan: 'asesoria' },
  });

  return subscription;
}
