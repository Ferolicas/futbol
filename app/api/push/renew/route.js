import { z } from 'zod';
import { supabaseAdmin } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';

// Renovación de suscripción push SIN sesión.
//
// El service worker llama aquí desde 'pushsubscriptionchange' cuando el
// navegador rota/caduca la suscripción. En una PWA dormida la cookie de sesión
// puede haber expirado, así que NO exigimos auth: el `oldEndpoint` (una URL
// larga e imposible de adivinar emitida por el push server) actúa como prueba
// de propiedad. Solo hacemos SWAP dentro de una fila existente que ya contenga
// ese endpoint — nunca creamos filas nuevas ni tocamos otras, así la superficie
// de abuso es mínima.

const schema = z.object({
  oldEndpoint: z.string().min(12),
  subscription: z.object({
    endpoint: z.string().min(12),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }).passthrough(),
});

function toArray(stored) {
  if (!stored) return [];
  return Array.isArray(stored) ? stored : [stored];
}

export async function POST(request) {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid payload' }, { status: 400 });
  }
  const { oldEndpoint, subscription: newSub } = parsed.data;

  // Solo aceptamos endpoints https (los push servers siempre lo son).
  if (!oldEndpoint.startsWith('https://') || !newSub.endpoint.startsWith('https://')) {
    return Response.json({ error: 'Invalid endpoint' }, { status: 400 });
  }

  // Buscar la fila que contiene el endpoint viejo. A la escala de esta app el
  // escaneo es trivial; no creamos filas si no se encuentra (anti-abuso).
  const { data: rows, error } = await supabaseAdmin
    .from('push_subscriptions')
    .select('user_id, subscription');
  if (error) {
    console.error('[push:renew] read error:', error.message);
    return Response.json({ error: 'DB error' }, { status: 500 });
  }

  const target = (rows || []).find(r =>
    toArray(r.subscription).some(s => s?.endpoint === oldEndpoint),
  );
  if (!target) {
    // Nada que renovar (el endpoint viejo ya no existe). No-op idempotente.
    return Response.json({ renewed: false }, { status: 200 });
  }

  // Reemplazar el endpoint viejo por la nueva suscripción; dedup también por el
  // endpoint nuevo (por si ya estuviera).
  const updated = [
    ...toArray(target.subscription).filter(
      s => s?.endpoint !== oldEndpoint && s?.endpoint !== newSub.endpoint,
    ),
    newSub,
  ];

  const { error: upErr } = await supabaseAdmin
    .from('push_subscriptions')
    .update({ subscription: updated })
    .eq('user_id', target.user_id);
  if (upErr) {
    console.error('[push:renew] update error:', upErr.message);
    return Response.json({ error: 'DB error' }, { status: 500 });
  }

  return Response.json({ renewed: true, deviceCount: updated.length });
}
