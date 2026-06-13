// POST /api/mercadopago/webhook — notificaciones de Mercado Pago.
//
// Maneja:
//   - preapproval (suscripción con tarjeta): authorized → active, cancelled, etc.
//   - payment / order (PSE/Efecty, pago del periodo): approved/paid → active.
//
// Seguridad doble: 1) valida la firma x-signature con MP_WEBHOOK_SECRET;
// 2) NO confía en el payload: relee el recurso real desde la API de MP con
// nuestro token. Idempotente por id+estado.
import { supabaseAdmin } from '../../../../lib/supabase';
import { redisGet, redisSet } from '../../../../lib/redis';
import { sendPlanActivatedEmail } from '../../../../lib/email';
import { getPreapproval, mpStatusToApp, mpAccessToken, verifyWebhookSignature } from '../../../../lib/mercadopago';

export const dynamic = 'force-dynamic';

const MP_API = 'https://api.mercadopago.com';

async function mpGet(path) {
  const res = await fetch(`${MP_API}${path}`, {
    headers: { Authorization: `Bearer ${mpAccessToken()}` },
  });
  return res.ok ? res.json() : null;
}

async function applyStatus({ externalRef, preapprovalId, appStatus, dedupeKey }) {
  let query = supabaseAdmin.from('user_profiles').select('id, name, email, plan');
  query = externalRef ? query.eq('id', externalRef) : query.eq('mp_preapproval_id', preapprovalId);
  const { data: profile } = await query.single();
  if (!profile) {
    console.error('[mp:webhook] usuario no encontrado', { externalRef, preapprovalId });
    return Response.json({ received: true, unmatched: true });
  }

  const seen = await redisGet(dedupeKey);
  if (seen === appStatus) return Response.json({ received: true, deduped: true });

  const patch = {
    subscription_status: appStatus,
    payment_provider: 'mercadopago',
    updated_at: new Date().toISOString(),
  };
  if (preapprovalId) patch.mp_preapproval_id = preapprovalId;
  const { error } = await supabaseAdmin.from('user_profiles').update(patch).eq('id', profile.id);
  if (error) throw new Error(`update: ${error.message}`);

  if (appStatus === 'active' && seen !== 'active') {
    try {
      await sendPlanActivatedEmail({ to: profile.email, name: profile.name, plan: profile.plan || 'mensual' });
    } catch (e) {
      console.error('[mp:webhook] email activación falló:', e.message);
    }
  }
  await redisSet(dedupeKey, appStatus, 30 * 24 * 3600);
  console.log('[mp:webhook]', dedupeKey, '→', appStatus, 'user', profile.id);
  return Response.json({ received: true });
}

export async function POST(request) {
  const url = new URL(request.url);
  // data.id de la QUERY STRING — es EXACTAMENTE lo que MP firma en x-signature.
  const dataIdFromQuery = url.searchParams.get('data.id') || url.searchParams.get('id');
  let type = url.searchParams.get('type') || url.searchParams.get('topic');

  const body = await request.json().catch(() => null);
  if (body) {
    type = body.type || body.topic || type;
  }
  // id del recurso a releer: el del query (coincide con la firma) o, si falta, el del body.
  const id = dataIdFromQuery || body?.data?.id || body?.id;
  if (!id || !type) return Response.json({ received: true, ignored: true });

  // 1) Firma (defensa en profundidad). La verificamos con el data.id del QUERY,
  //    que es lo que MP firma. Si NO valida, NO rechazamos: la seguridad real es
  //    la re-lectura del recurso vía API con nuestro token (un id falso da 404 o
  //    estado != approved → no activa; un id real activa al titular que pagó, no
  //    a un atacante). Rechazar con 401 por firma dejaba a clientes que pagaron
  //    SIN activar — ese era el bug crítico.
  const sig = verifyWebhookSignature(request, dataIdFromQuery || id);
  if (sig === false) {
    console.warn('[mp:webhook] x-signature no validó — se continúa por re-lectura API', { id, type });
  }

  try {
    // 2) Suscripción (tarjeta)
    if (/preapproval/i.test(type)) {
      const pa = await getPreapproval(id);
      if (!pa) return Response.json({ received: true, notfound: true });
      return await applyStatus({
        externalRef: pa.external_reference,
        preapprovalId: id,
        appStatus: mpStatusToApp(pa.status),
        dedupeKey: `mp-preapproval:${id}`,
      });
    }

    // 3) Pago único (PSE/Efecty) — payment u order
    if (/payment/i.test(type)) {
      const p = await mpGet(`/v1/payments/${id}`);
      if (!p) return Response.json({ received: true, notfound: true });
      const appStatus = p.status === 'approved' ? 'active'
        : (p.status === 'rejected' || p.status === 'cancelled') ? 'cancelled' : 'pending';
      return await applyStatus({ externalRef: p.external_reference, appStatus, dedupeKey: `mp-payment:${id}` });
    }
    if (/order/i.test(type)) {
      const o = await mpGet(`/v1/orders/${id}`);
      if (!o) return Response.json({ received: true, notfound: true });
      const paid = o.status === 'processed' || o.status === 'paid' || o.status_detail === 'accredited';
      const appStatus = paid ? 'active' : (o.status === 'cancelled' ? 'cancelled' : 'pending');
      return await applyStatus({ externalRef: o.external_reference, appStatus, dedupeKey: `mp-order:${id}` });
    }

    return Response.json({ received: true, ignored: type });
  } catch (e) {
    console.error('[mp:webhook]', e.message);
    return Response.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
}
