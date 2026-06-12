// ─────────────────────────────────────────────────────────────────────────────
// POST /api/hotmart/webhook — Postback (Webhook 2.0) de Hotmart.
//
// Reemplaza el webhook de Stripe (/api/webhook) para la migración a Hotmart.
// Hotmart llama aquí en cada cambio de estado de una compra/suscripción.
//
// Seguridad: se verifica el HOTTOK (token único de la cuenta) en el header
// `X-HOTMART-HOTTOK` o en el body. Sin token válido → 401 (igual que la firma
// obligatoria del webhook de Stripe: nadie debe poder activarse un plan gratis).
//
// Idempotencia: dedup por el id del evento en Redis (Hotmart reintenta).
// ─────────────────────────────────────────────────────────────────────────────
import { supabaseAdmin } from '../../../../lib/supabase';
import { sendPlanActivatedEmail } from '../../../../lib/email';
import { redisGet, redisSet } from '../../../../lib/redis';
import { classifyHotmartEvent, extractHotmartFields } from '../../../../lib/hotmart';

export const dynamic = 'force-dynamic';

function verifyHottok(request, payload) {
  const expected = process.env.HOTMART_HOTTOK;
  if (!expected) return false; // sin secreto configurado → rechazar (fail-closed)
  const fromHeader = request.headers.get('x-hotmart-hottok')
    || request.headers.get('hottok');
  const fromBody = payload?.hottok || payload?.data?.hottok;
  return fromHeader === expected || fromBody === expected;
}

// Busca al usuario de CF Análisis: 1) por sck=userId (tracking), 2) por email.
async function findProfile({ email, sck }) {
  if (sck) {
    const { data } = await supabaseAdmin
      .from('user_profiles')
      .select('id, name, email, plan, role')
      .eq('id', sck)
      .single();
    if (data) return data;
  }
  if (email) {
    const { data } = await supabaseAdmin
      .from('user_profiles')
      .select('id, name, email, plan, role')
      .eq('email', email)
      .single();
    if (data) return data;
  }
  return null;
}

async function setStatus(profile, status, { plan, subscriberCode } = {}) {
  const patch = {
    subscription_status: status,
    payment_provider: 'hotmart',
    updated_at: new Date().toISOString(),
  };
  if (plan) patch.plan = plan;
  if (subscriberCode) patch.hotmart_subscriber_code = subscriberCode;
  const { error } = await supabaseAdmin.from('user_profiles').update(patch).eq('id', profile.id);
  // Propagar el error (igual que el webhook de Stripe): si la activación falla,
  // devolvemos 500 y NO marcamos el dedup → Hotmart reintenta hasta persistir.
  if (error) throw new Error(`update failed: ${error.message}`);
}

export async function POST(request) {
  const raw = await request.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!verifyHottok(request, payload)) {
    console.error('[hotmart] Rechazado: hottok inválido o ausente');
    return Response.json({ error: 'Invalid hottok' }, { status: 401 });
  }

  const eventName = payload.event || payload.data?.event || 'UNKNOWN';
  const eventId = payload.id || payload.creation_date || `${eventName}:${Date.now()}`;

  // Idempotencia: si ya procesamos este evento, salir.
  if (await redisGet(`hotmart-event:${eventId}`)) {
    return Response.json({ received: true, deduped: true });
  }

  const fields = extractHotmartFields(payload);
  const action = classifyHotmartEvent(eventName);
  console.log('[hotmart] evento', eventName, '→', action,
    JSON.stringify({ email: fields.email, plan: fields.plan, offer: fields.offerCode, sck: fields.sck }));

  if (action === 'ignore') {
    return Response.json({ received: true, ignored: eventName });
  }

  try {
    const profile = await findProfile(fields);
    if (!profile) {
      // No encontramos la cuenta (pagó con otro email y sin sck). Lo dejamos
      // registrado para gestión manual; respondemos 200 para que Hotmart no
      // reintente eternamente un evento que no podemos casar automáticamente.
      console.error('[hotmart] usuario no encontrado:', JSON.stringify(fields));
      await redisSet(`hotmart-event:${eventId}`, '1', 7 * 24 * 3600);
      return Response.json({ received: true, unmatched: true });
    }

    if (action === 'activate') {
      await setStatus(profile, 'active', { plan: fields.plan, subscriberCode: fields.subscriberCode });
      try {
        await sendPlanActivatedEmail({ to: profile.email, name: profile.name, plan: fields.plan || profile.plan || 'mensual' });
      } catch (e) {
        console.error('[hotmart] email de activación falló:', e.message);
      }
    } else if (action === 'switch') {
      await setStatus(profile, 'active', { plan: fields.plan, subscriberCode: fields.subscriberCode });
    } else if (action === 'past_due') {
      await setStatus(profile, 'past_due', { subscriberCode: fields.subscriberCode });
    } else if (action === 'deactivate') {
      await setStatus(profile, 'cancelled', { subscriberCode: fields.subscriberCode });
    }

    // Éxito → marcar el evento como procesado (a partir de aquí los reintentos se saltan).
    await redisSet(`hotmart-event:${eventId}`, '1', 7 * 24 * 3600);
    return Response.json({ received: true });
  } catch (error) {
    console.error('[hotmart] handler error:', error.message);
    return Response.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
}
