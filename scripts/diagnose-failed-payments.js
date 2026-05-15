/* eslint-disable */
/**
 * diagnose-failed-payments.js
 *
 * Lista todos los usuarios con subscription_status = 'past_due' o
 * 'inactive', consulta Stripe para obtener:
 *   - Razon EXACTA del fallo (last_payment_error.decline_code / code)
 *   - Estado actual de la suscripcion en Stripe
 *   - Si hay open invoices pendientes que se puedan reintentar
 *
 * USO:
 *   node scripts/diagnose-failed-payments.js
 *   node scripts/diagnose-failed-payments.js --json   # output JSON
 *
 * Variables necesarias (en .env.local):
 *   STRIPE_SECRET_KEY
 *   DATABASE_URL  (VPS Postgres)
 */

require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 3,
});

const asJson = process.argv.includes('--json');

// Razones humanas para los decline codes mas comunes
const DECLINE_REASONS = {
  generic_decline: 'Banco rechazó sin razón específica',
  insufficient_funds: 'Fondos insuficientes',
  lost_card: 'Tarjeta reportada como perdida',
  stolen_card: 'Tarjeta reportada como robada',
  expired_card: 'Tarjeta expirada',
  incorrect_cvc: 'CVC incorrecto',
  processing_error: 'Error procesando — reintentar',
  card_velocity_exceeded: 'Demasiados intentos en poco tiempo',
  fraudulent: 'Banco marcó como fraude',
  authentication_required: 'Requiere 3D Secure (SCA) — usuario debe re-autenticar',
  do_not_honor: 'Banco rechazó genericamente (do_not_honor)',
  call_issuer: 'Banco requiere contacto del titular',
  pickup_card: 'Banco solicita retener la tarjeta',
  restricted_card: 'Tarjeta restringida',
};

async function main() {
  // 1. Usuarios con problemas de pago en el VPS
  const { rows: users } = await pool.query(`
    SELECT id, email, name, plan, subscription_status, stripe_customer_id, updated_at
    FROM user_profiles
    WHERE subscription_status IN ('past_due', 'inactive', 'pending')
      AND stripe_customer_id IS NOT NULL
    ORDER BY updated_at DESC
  `);

  if (users.length === 0) {
    console.log('[diagnose] no users with payment issues');
    await pool.end();
    return;
  }

  if (!asJson) console.log(`[diagnose] ${users.length} usuarios con problemas de pago\n`);

  const results = [];

  for (const u of users) {
    const entry = {
      userId: u.id, email: u.email, name: u.name, plan: u.plan,
      dbStatus: u.subscription_status, customerId: u.stripe_customer_id,
      lastUpdate: u.updated_at,
      stripe: { subscriptionStatus: null, lastError: null, openInvoiceId: null, retryable: false },
    };

    try {
      // 2a. Suscripcion mas reciente
      const subs = await stripe.subscriptions.list({
        customer: u.stripe_customer_id, limit: 1, status: 'all',
      });
      const sub = subs.data[0];
      if (sub) {
        entry.stripe.subscriptionStatus = sub.status;
        entry.stripe.subscriptionId = sub.id;
      }

      // 2b. Open invoices (lo que el banco rechazo y se puede reintentar)
      const invoices = await stripe.invoices.list({
        customer: u.stripe_customer_id, limit: 5, status: 'open',
      });
      const openInv = invoices.data.find(i => i.amount_due > 0);
      if (openInv) {
        entry.stripe.openInvoiceId = openInv.id;
        entry.stripe.openInvoiceAmount = openInv.amount_due / 100;
        entry.stripe.openInvoiceCurrency = openInv.currency;
        entry.stripe.retryable = true;
      }

      // 2c. last_payment_error del payment_intent mas reciente fallido
      const pis = await stripe.paymentIntents.list({
        customer: u.stripe_customer_id, limit: 10,
      });
      const failed = pis.data.find(pi => pi.status === 'requires_payment_method' && pi.last_payment_error);
      if (failed) {
        const e = failed.last_payment_error;
        entry.stripe.lastError = {
          code: e.code, declineCode: e.decline_code, message: e.message,
          humanReason: DECLINE_REASONS[e.decline_code] || DECLINE_REASONS[e.code] || e.message,
          paymentIntentId: failed.id,
        };
      }
    } catch (e) {
      entry.stripe.error = e.message;
    }

    results.push(entry);
  }

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      console.log('───────────────────────────────────────────────────────');
      console.log(`  ${r.email}  (${r.name || '—'})`);
      console.log(`  plan: ${r.plan}    DB: ${r.dbStatus}    Stripe: ${r.stripe.subscriptionStatus || 'N/A'}`);
      console.log(`  customer: ${r.customerId}`);
      if (r.stripe.lastError) {
        console.log(`  ❌ último error: ${r.stripe.lastError.humanReason}`);
        console.log(`     code=${r.stripe.lastError.code} decline_code=${r.stripe.lastError.declineCode || '—'}`);
        console.log(`     payment_intent=${r.stripe.lastError.paymentIntentId}`);
      }
      if (r.stripe.openInvoiceId) {
        console.log(`  💸 invoice abierta: ${r.stripe.openInvoiceId} — ${r.stripe.openInvoiceAmount} ${r.stripe.openInvoiceCurrency?.toUpperCase()} — REINTENTABLE`);
      }
      if (r.stripe.error) console.log(`  ⚠ stripe error: ${r.stripe.error}`);
    }
    console.log('───────────────────────────────────────────────────────');
    console.log(`Total: ${results.length}`);
    console.log(`Reintentables: ${results.filter(r => r.stripe.retryable).length}`);
    console.log('\nPara reintentar los cobros: node scripts/retry-failed-payments.js');
  }

  await pool.end();
}

main().catch(async (e) => { console.error('[diagnose] FATAL:', e.message); await pool.end(); process.exit(1); });
