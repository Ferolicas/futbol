#!/usr/bin/env node

import Stripe from 'stripe';
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const execute = process.argv.includes('--execute');
const secret = process.env.STRIPE_SECRET_KEY;
const endpointUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://cfanalisis.com'}/api/webhook`;
if (!secret) throw new Error('STRIPE_SECRET_KEY no configurada');

const stripe = new Stripe(secret, { maxNetworkRetries: 2, timeout: 20_000 });
const required = [
  'payment_intent.succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'invoice.finalization_failed',
  'invoice.marked_uncollectible',
  'invoice.voided',
];

const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
const endpoint = endpoints.data.find((item) => item.url === endpointUrl && item.status === 'enabled');
if (!endpoint) throw new Error(`No existe un webhook Stripe activo para ${endpointUrl}`);

const current = endpoint.enabled_events.includes('*') ? ['*'] : endpoint.enabled_events;
const desired = current.includes('*') ? current : [...new Set([...current, ...required])].sort();
const missing = current.includes('*') ? [] : required.filter((event) => !current.includes(event));

console.log(JSON.stringify({ endpoint: endpoint.url, missing, execute }, null, 2));
if (execute && missing.length) {
  await stripe.webhookEndpoints.update(endpoint.id, { enabled_events: desired });
  console.log('Webhook Stripe actualizado correctamente.');
} else if (!execute && missing.length) {
  console.log('Dry-run: usa --execute despues de desplegar el handler nuevo.');
}
