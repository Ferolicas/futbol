// POST /api/mercadopago/webhook — notificaciones (IPN/Webhooks) de Mercado Pago.
//
// MP avisa con { type, data: { id } } (o por query ?type=&data.id=). NO confiamos
// en el payload: con el id releemos el estado REAL desde la API de MP con nuestro
// token (un atacante no puede falsear el estado, solo el id). Según el estado del
// preapproval activamos/cancelamos el plan. Idempotente por id.
import { supabaseAdmin } from '../../../../lib/supabase';
import { redisGet, redisSet } from '../../../../lib/redis';
import { sendPlanActivatedEmail } from '../../../../lib/email';
import { getPreapproval, mpStatusToApp } from '../../../../lib/mercadopago';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const url = new URL(request.url);
  let type = url.searchParams.get('type') || url.searchParams.get('topic');
  let id = url.searchParams.get('data.id') || url.searchParams.get('id');

  const body = await request.json().catch(() => null);
  if (body) {
    type = body.type || body.topic || type;
    id = body.data?.id || body.id || id;
  }

  // Solo nos interesan las notificaciones de suscripción (preapproval).
  if (!id || !type || !/preapproval/i.test(type)) {
    return Response.json({ received: true, ignored: type || 'unknown' });
  }

  // Idempotencia: misma notificación (id+estado) procesada una vez.
  const dedupeKey = `mp-preapproval:${id}`;

  try {
    const pa = await getPreapproval(id);
    if (!pa) return Response.json({ received: true, notfound: true });

    const appStatus = mpStatusToApp(pa.status);
    const userId = pa.external_reference || null;

    // Buscar al usuario por external_reference (userId) o por el preapproval id.
    let query = supabaseAdmin.from('user_profiles').select('id, name, email, plan');
    query = userId ? query.eq('id', userId) : query.eq('mp_preapproval_id', id);
    const { data: profile } = await query.single();
    if (!profile) {
      console.error('[mp:webhook] usuario no encontrado para preapproval', id, 'ext_ref', userId);
      return Response.json({ received: true, unmatched: true });
    }

    // Dedup por estado: si ya aplicamos este estado para este id, salir.
    const seen = await redisGet(dedupeKey);
    if (seen === appStatus) return Response.json({ received: true, deduped: true });

    const { error } = await supabaseAdmin.from('user_profiles').update({
      subscription_status: appStatus,
      mp_preapproval_id: id,
      payment_provider: 'mercadopago',
      updated_at: new Date().toISOString(),
    }).eq('id', profile.id);
    if (error) throw new Error(`update: ${error.message}`);

    if (appStatus === 'active' && seen !== 'active') {
      try {
        await sendPlanActivatedEmail({ to: profile.email, name: profile.name, plan: profile.plan || 'mensual' });
      } catch (e) {
        console.error('[mp:webhook] email activación falló:', e.message);
      }
    }

    await redisSet(dedupeKey, appStatus, 30 * 24 * 3600);
    console.log('[mp:webhook] preapproval', id, '→', pa.status, '→', appStatus, 'user', profile.id);
    return Response.json({ received: true });
  } catch (e) {
    console.error('[mp:webhook]', e.message);
    return Response.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
}
