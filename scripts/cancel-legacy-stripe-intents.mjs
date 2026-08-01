#!/usr/bin/env node

import Stripe from 'stripe';
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const execute = process.argv.includes('--execute');
const plans = new Set(['semanal', 'mensual', 'trimestral', 'semestral', 'anual']);
const cancellable = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
]);
const userIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY no configurada');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 20_000 });
const candidates = [];
for await (const intent of stripe.paymentIntents.list({ limit: 100 })) {
  if (
    cancellable.has(intent.status)
    && !intent.metadata?.checkoutAttemptId
    && plans.has(intent.metadata?.plan)
    && userIdPattern.test(intent.metadata?.userId || '')
  ) {
    candidates.push(intent);
  }
}

console.log(JSON.stringify({
  execute,
  count: candidates.length,
  candidates: candidates.map((intent) => ({
    id: intent.id,
    status: intent.status,
    plan: intent.metadata.plan,
    created: new Date(intent.created * 1000).toISOString(),
  })),
}, null, 2));

if (!execute) {
  if (candidates.length) console.log('Dry-run: usa --execute despues de desplegar el flujo nuevo.');
  process.exit(0);
}

for (const intent of candidates) {
  await stripe.paymentIntents.cancel(
    intent.id,
    {},
    { idempotencyKey: `cf-cancel-legacy-${intent.id}` },
  );
}
console.log(`PaymentIntents legacy cancelados: ${candidates.length}`);
