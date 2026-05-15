/* eslint-disable */
/**
 * retry-failed-payments.js
 *
 * Reintenta el cobro de TODAS las invoices abiertas (status='open') para
 * usuarios con subscription_status='past_due'|'inactive'. Para cada una:
 *   1. stripe.invoices.pay(invoiceId) — intenta cobrar con el default PM
 *   2. Si exitoso → webhook ya escucha invoice.payment_succeeded y
 *      actualizara user_profiles.subscription_status='active' solo.
 *      Como respaldo defensivo, este script tambien lo actualiza.
 *   3. Si falla → loguea la nueva razon (probablemente la misma de antes).
 *
 * USO:
 *   node scripts/retry-failed-payments.js                # dry-run (default seguro)
 *   node scripts/retry-failed-payments.js --execute      # ejecuta los pagos
 *   node scripts/retry-failed-payments.js --email=x@y.com --execute   # filtrar
 *
 * NO requiere accion del usuario (Stripe usa default_payment_method). Si
 * la tarjeta caduco o requiere 3DS, el reintento fallara igual y el
 * usuario tendra que actualizar su tarjeta manualmente.
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

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const emailFilter = args.find(a => a.startsWith('--email='))?.slice(8);

async function main() {
  const params = ['past_due', 'inactive'];
  let q = `
    SELECT id, email, name, plan, stripe_customer_id
    FROM user_profiles
    WHERE subscription_status = ANY($1::text[])
      AND stripe_customer_id IS NOT NULL
  `;
  if (emailFilter) { q += ` AND lower(email) = lower($2)`; params.push(emailFilter); }
  q += ' ORDER BY updated_at DESC';

  const { rows: users } = await pool.query(q, params);
  if (users.length === 0) {
    console.log('[retry] no users to retry');
    await pool.end();
    return;
  }

  console.log(`[retry] ${EXECUTE ? 'EJECUTANDO' : 'DRY-RUN'} sobre ${users.length} usuarios`);
  console.log('---');

  let attempted = 0, succeeded = 0, failed = 0, skipped = 0;

  for (const u of users) {
    try {
      const invoices = await stripe.invoices.list({
        customer: u.stripe_customer_id, limit: 5, status: 'open',
      });
      const openInv = invoices.data.find(i => i.amount_due > 0);

      if (!openInv) {
        console.log(`  ⊘ ${u.email} — sin invoice abierta`);
        skipped++;
        continue;
      }

      attempted++;
      const amount = (openInv.amount_due / 100).toFixed(2);
      const cur = openInv.currency?.toUpperCase();

      if (!EXECUTE) {
        console.log(`  [dry] ${u.email} — reintentaria invoice ${openInv.id} (${amount} ${cur})`);
        continue;
      }

      console.log(`  → ${u.email} — pagando invoice ${openInv.id} (${amount} ${cur})…`);
      const paid = await stripe.invoices.pay(openInv.id);

      if (paid.status === 'paid') {
        // Webhook ya hace el update, pero como respaldo defensivo:
        await pool.query(
          `UPDATE user_profiles SET subscription_status = 'active', updated_at = NOW()
           WHERE id = $1`, [u.id],
        );
        console.log(`     ✓ OK — paid (${paid.id})`);
        succeeded++;
      } else {
        console.log(`     ⚠ status=${paid.status}`);
        failed++;
      }
    } catch (e) {
      failed++;
      const code = e?.code || e?.raw?.code || 'unknown';
      const declineCode = e?.decline_code || e?.raw?.decline_code;
      console.log(`     ✗ FAIL ${u.email}: ${code}${declineCode ? '/' + declineCode : ''} — ${e.message}`);
    }
  }

  console.log('---');
  console.log(`Total intentados: ${attempted}  ✓ OK: ${succeeded}  ✗ FAIL: ${failed}  ⊘ skip: ${skipped}`);
  if (!EXECUTE) console.log('\n⚠ Modo dry-run. Para ejecutar realmente: añade --execute');

  await pool.end();
}

main().catch(async (e) => { console.error('[retry] FATAL:', e.message); await pool.end(); process.exit(1); });
