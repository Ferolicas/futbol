// POST /api/push/test
// Fires a test push notification to all the current user's registered devices.
// Use to verify end-to-end push delivery (SW + VAPID + subscription persistence).
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../../lib/supabase';
import { sendPushNotification } from '../../../../lib/webpush';

export const dynamic = 'force-dynamic';

function toArray(stored) {
  if (!stored) return [];
  const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function POST() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  // Env sanity check first — easiest failure to diagnose
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return Response.json({
      ok: false,
      reason: 'VAPID keys missing on the server. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Vercel.',
    }, { status: 500 });
  }

  const { data: row, error } = await supabaseAdmin
    .from('push_subscriptions')
    .select('subscription')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) return Response.json({ ok: false, reason: error.message }, { status: 500 });

  const subs = toArray(row?.subscription);
  if (subs.length === 0) {
    return Response.json({
      ok: false,
      reason: 'No tienes ningún dispositivo registrado. Pulsa primero el icono de campana (🔕→🔔) en el dashboard y acepta el permiso del navegador.',
    });
  }

  const results = await Promise.allSettled(subs.map(async (sub) => {
    if (!sub?.endpoint) return { skipped: true };
    const r = await sendPushNotification(sub, {
      title: '🔔 Test CFanalisis',
      body:  'Si ves esto, las notificaciones funcionan. Hora ' + new Date().toLocaleTimeString('es-ES'),
      tag:   'test-' + Date.now(),
    });
    return { endpoint: sub.endpoint.slice(-20), result: r };
  }));

  const summary = results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message });
  const ok = summary.some(s => s.result === true);

  // Clean up expired subscriptions
  const expiredEndpoints = new Set(
    summary.filter(s => s.result === 'expired').map(s => s.endpoint && subs.find(x => x.endpoint?.endsWith(s.endpoint))?.endpoint).filter(Boolean)
  );
  if (expiredEndpoints.size > 0) {
    const remaining = subs.filter(s => !expiredEndpoints.has(s.endpoint));
    if (remaining.length === 0) {
      await supabaseAdmin.from('push_subscriptions').delete().eq('user_id', user.id);
    } else {
      await supabaseAdmin.from('push_subscriptions').update({ subscription: remaining }).eq('user_id', user.id);
    }
  }

  return Response.json({
    ok,
    devicesCount: subs.length,
    delivered: summary.filter(s => s.result === true).length,
    expired: summary.filter(s => s.result === 'expired').length,
    failed: summary.filter(s => s.result === false).length,
    summary,
  });
}
