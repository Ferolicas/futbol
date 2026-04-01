import { stripe, createPostPaymentSubscription } from '../../../lib/stripe';
import { supabaseAdmin } from '../../../lib/supabase';
import { sendWelcomeEmail } from '../../../lib/resend-email';

async function findUserByCustomer(customerId, userId) {
  // 1. By stripe_customer_id in user_profiles
  let { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('id, name, email, plan, role')
    .eq('stripe_customer_id', customerId)
    .single();
  if (profile) return profile;

  // 2. By userId metadata
  if (userId) {
    const { data: p2 } = await supabaseAdmin
      .from('user_profiles')
      .select('id, name, email, plan, role')
      .eq('id', userId)
      .single();
    if (p2) return p2;
  }

  // 3. Fallback: email from Stripe customer
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer?.email) {
      const { data: p3 } = await supabaseAdmin
        .from('user_profiles')
        .select('id, name, email, plan, role')
        .eq('email', customer.email.toLowerCase())
        .single();
      return p3 || null;
    }
  } catch (e) {
    console.error('[webhook] Stripe customer lookup:', e.message);
  }
  return null;
}

async function activateUser(profile, plan, customerId) {
  await supabaseAdmin.from('user_profiles').upsert({
    id: profile.id,
    plan: plan || 'plataforma',
    subscription_status: 'active',
    stripe_customer_id: customerId,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' }).catch(e => console.error('[webhook:activate]', e.message));

  try {
    await sendWelcomeEmail({
      to: profile.email,
      name: profile.name,
      plan: plan || 'plataforma',
      password: '(la contrasena que elegiste al registrarte)',
    });
  } catch (e) {
    console.error('[webhook] Welcome email failed:', e.message);
  }
}

export async function POST(request) {
  if (!stripe) {
    return Response.json({ error: 'Stripe not configured' }, { status: 500 });
  }

  const body = await request.text();
  const sig = request.headers.get('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (webhookSecret && sig) {
      event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    } else {
      event = JSON.parse(body);
    }
  } catch (err) {
    console.error('[webhook] Signature failed:', err.message);
    return Response.json({ error: 'Webhook signature failed' }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const { userId, plan } = pi.metadata || {};
        const customerId = pi.customer;
        if (!plan || !customerId) break;

        const profile = await findUserByCustomer(customerId, userId);
        if (!profile) {
          console.error(`[webhook] User not found: customer=${customerId} userId=${userId}`);
          break;
        }
        await activateUser(profile, plan, customerId);

        try {
          const sub = await createPostPaymentSubscription(customerId, plan);
          console.log(`[webhook] Subscription created for ${plan}: ${sub.id}`);
        } catch (e) {
          console.error('[webhook] Failed to create subscription:', e.message);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const profile = await findUserByCustomer(subscription.customer);
        if (!profile) break;
        const status = ['active', 'trialing'].includes(subscription.status) ? 'active'
          : subscription.status === 'past_due' ? 'past_due' : 'inactive';
        await supabaseAdmin.from('user_profiles')
          .update({ subscription_status: status, updated_at: new Date().toISOString() })
          .eq('id', profile.id)
          .catch(e => console.error('[webhook:sub.updated]', e.message));
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const profile = await findUserByCustomer(subscription.customer);
        if (!profile) break;
        await supabaseAdmin.from('user_profiles')
          .update({ subscription_status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('id', profile.id)
          .catch(e => console.error('[webhook:sub.deleted]', e.message));
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const profile = await findUserByCustomer(invoice.customer);
        if (!profile) break;
        await supabaseAdmin.from('user_profiles')
          .update({ subscription_status: 'past_due', updated_at: new Date().toISOString() })
          .eq('id', profile.id)
          .catch(e => console.error('[webhook:invoice.failed]', e.message));
        break;
      }
    }
  } catch (error) {
    console.error('[webhook] Handler error:', error.message);
    return Response.json({ error: 'Webhook handler failed' }, { status: 500 });
  }

  return Response.json({ received: true });
}
