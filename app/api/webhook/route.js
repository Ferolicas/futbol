import { stripe, createPostPaymentSubscription } from '../../../lib/stripe';
import { supabaseAdmin } from '../../../lib/supabase';
import { sendPlanActivatedEmail } from '../../../lib/email';
import { redisGet, redisSet } from '../../../lib/redis';

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
  const { error: _err1 } = await supabaseAdmin.from('user_profiles').update({
    plan: plan || 'mensual',
    subscription_status: 'active',
    stripe_customer_id: customerId,
    updated_at: new Date().toISOString(),
  }).eq('id', profile.id);
  // A-1 FIX (fiabilidad): propagar el error de activación. Antes solo se logueaba
  // → el cliente pagaba y se quedaba SIN acceso en silencio. Ahora lanza: el
  // handler lo captura, devuelve 500 y NO marca el dedup → Stripe reintenta hasta
  // que la activación persiste.
  if (_err1) throw new Error(`activation update failed: ${_err1.message}`);

  // Email de activación: una sola vez, SOLO tras activar con éxito. NO bloquea —
  // si el UPDATE fue bien pero el email falla, la activación NO se revierte.
  try {
    await sendPlanActivatedEmail({
      to: profile.email,
      name: profile.name,
      plan: plan || 'mensual',
    });
  } catch (e) {
    console.error('[webhook] Plan activated email failed:', e.message);
  }
}

export async function POST(request) {
  if (!stripe) {
    return Response.json({ error: 'Stripe not configured' }, { status: 500 });
  }

  const body = await request.text();
  const sig = request.headers.get('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // R3 FIX: firma SIEMPRE obligatoria. Antes, sin secret/sig se hacía
  // JSON.parse(body) y se procesaba el evento → cualquiera podía POSTear un
  // payment_intent.succeeded falso y activarse un plan gratis. Ahora, sin
  // verificación criptográfica de Stripe, se rechaza.
  if (!webhookSecret || !sig) {
    console.error('[webhook] Rechazado: falta STRIPE_WEBHOOK_SECRET o stripe-signature');
    return Response.json({ error: 'Webhook signature required' }, { status: 400 });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    console.error('[webhook] Signature failed:', err.message);
    return Response.json({ error: 'Webhook signature failed' }, { status: 400 });
  }

  // R4 + A-1 FIX: idempotencia. La COMPROBACIÓN del dedup se queda aquí (saltar
  // si el evento ya se procesó). El MARCADO (redisSet) se movió al handler de
  // payment_intent.succeeded, DESPUÉS de activar con éxito: así un fallo de
  // activación NO queda "visto" y Stripe puede reintentar hasta activar al
  // cliente. Los demás eventos (subscription.*, invoice.*) son UPDATEs
  // idempotentes → reprocesarlos en un reintento es inocuo.
  if (event.id) {
    const seen = await redisGet(`stripe-event:${event.id}`);
    if (seen) {
      return Response.json({ received: true, deduped: true });
    }
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

        // A-1 FIX: activar PRIMERO. Si el UPDATE falla, activateUser LANZA → cae
        // al catch del handler → 500 → Stripe reintenta y el dedup (abajo) NO se
        // marca → el cliente acaba activándose.
        await activateUser(profile, plan, customerId);

        // Activación OK (debitado + plan activo + email). SOLO AHORA marcamos el
        // evento como visto: a partir de aquí un reintento de Stripe se salta (no
        // re-cobra, no re-activa, no re-envía email).
        if (event.id) {
          await redisSet(`stripe-event:${event.id}`, '1', 24 * 3600);
        }

        // Suscripción recurrente: proceso SEPARADO que NUNCA entorpece el acceso
        // del cliente. Idempotente con event.id → un reintento jamás crea una 2ª
        // suscripción. Un fallo aquí (método de pago no apto para cobros
        // recurrentes, etc.) es PERMANENTE: NO se revierte la activación, NO se
        // reenvía email, NO se devuelve 500, NO se reintenta dentro del webhook.
        // Se registra en columnas + log para gestión manual.
        try {
          const sub = await createPostPaymentSubscription(customerId, plan, pi.payment_method, pi.created, event.id);
          console.log(`[webhook] Subscription created for ${plan}: ${sub.id}`);
          await supabaseAdmin.from('user_profiles')
            .update({ subscription_setup_status: 'done', subscription_setup_error: null })
            .eq('id', profile.id);
        } catch (e) {
          const setupError = `${e.code || 'error'}: ${e.message}`;
          await supabaseAdmin.from('user_profiles')
            .update({ subscription_setup_status: 'failed', subscription_setup_error: setupError })
            .eq('id', profile.id);
          console.error('[webhook:SUBSCRIPTION_SETUP_FAILED]', { eventId: event.id, customerId, userId, plan, error: setupError });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const profile = await findUserByCustomer(subscription.customer);
        if (!profile) break;
        const status = ['active', 'trialing'].includes(subscription.status) ? 'active'
          : subscription.status === 'past_due' ? 'past_due' : 'inactive';
        const { error: _err2 } = await supabaseAdmin.from('user_profiles')
          .update({ subscription_status: status, updated_at: new Date().toISOString() })
          .eq('id', profile.id);
        if (_err2) console.error('[webhook:sub.updated]', _err2.message);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const profile = await findUserByCustomer(subscription.customer);
        if (!profile) break;
        const { error: _err3 } = await supabaseAdmin.from('user_profiles')
          .update({ subscription_status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('id', profile.id);
        if (_err3) console.error('[webhook:sub.deleted]', _err3.message);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const profile = await findUserByCustomer(invoice.customer);
        if (!profile) break;
        const { error: _err4 } = await supabaseAdmin.from('user_profiles')
          .update({ subscription_status: 'past_due', updated_at: new Date().toISOString() })
          .eq('id', profile.id);
        if (_err4) console.error('[webhook:invoice.failed]', _err4.message);
        break;
      }
    }
  } catch (error) {
    console.error('[webhook] Handler error:', error.message);
    return Response.json({ error: 'Webhook handler failed' }, { status: 500 });
  }

  return Response.json({ received: true });
}
