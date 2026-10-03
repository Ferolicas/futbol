import { z } from 'zod';
import { getCurrentUser } from '../../../../lib/auth-pg';
import { supabaseAdmin } from '../../../../lib/supabase';
import { vapidPublicKey } from '../../../../lib/webpush';
import { redisRateLimit, clientIp } from '../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

const endpointSchema = z.string().url().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
});
const subscriptionSchema = z.object({
  endpoint: endpointSchema,
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(16).max(512),
    auth: z.string().min(8).max(256),
  }).strict(),
}).strict();

export async function GET() {
  return Response.json({ vapidPublicKey });
}

function toArray(stored) {
  if (!stored) return [];
  return Array.isArray(stored) ? stored : [stored];
}

async function authenticated(request, bucket) {
  const user = await getCurrentUser();
  if (!user) return { response: Response.json({ error: 'Unauthorized' }, { status: 401 }) };
  const limit = await redisRateLimit(bucket, `${user.id}:${clientIp(request)}`, 20, 60, { failClosed: true });
  if (!limit.success) {
    return { response: Response.json({ error: 'Too many requests' }, { status: limit.available ? 429 : 503 }) };
  }
  return { user };
}

export async function POST(request) {
  const auth = await authenticated(request, 'push-subscribe');
  if (auth.response) return auth.response;
  const parsed = subscriptionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid subscription' }, { status: 400 });
  const newSub = parsed.data;

  const { data: existing, error: readError } = await supabaseAdmin
    .from('push_subscriptions').select('subscription').eq('user_id', auth.user.id).maybeSingle();
  if (readError) return Response.json({ error: 'DB error' }, { status: 500 });

  const updatedArray = [
    ...toArray(existing?.subscription).filter(item => item?.endpoint !== newSub.endpoint).slice(-4),
    newSub,
  ];
  const { error } = await supabaseAdmin.from('push_subscriptions').upsert({
    user_id: auth.user.id,
    subscription: updatedArray,
  }, { onConflict: 'user_id' });
  if (error) {
    console.error('[push:subscribe]', error.message);
    return Response.json({ error: 'No se pudo guardar la suscripción' }, { status: 500 });
  }
  return Response.json({ success: true, deviceCount: updatedArray.length });
}

export async function DELETE(request) {
  const auth = await authenticated(request, 'push-unsubscribe');
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => ({}));
  const endpoint = body?.endpoint == null ? null : endpointSchema.safeParse(body.endpoint);
  if (endpoint && !endpoint.success) return Response.json({ error: 'Invalid endpoint' }, { status: 400 });

  if (endpoint?.data) {
    const { data: existing } = await supabaseAdmin
      .from('push_subscriptions').select('subscription').eq('user_id', auth.user.id).maybeSingle();
    const remaining = toArray(existing?.subscription).filter(item => item?.endpoint !== endpoint.data);
    const query = remaining.length === 0
      ? supabaseAdmin.from('push_subscriptions').delete().eq('user_id', auth.user.id)
      : supabaseAdmin.from('push_subscriptions').update({ subscription: remaining }).eq('user_id', auth.user.id);
    const { error } = await query;
    if (error) return Response.json({ error: 'DB error' }, { status: 500 });
  } else {
    const { error } = await supabaseAdmin.from('push_subscriptions').delete().eq('user_id', auth.user.id);
    if (error) return Response.json({ error: 'DB error' }, { status: 500 });
  }
  return Response.json({ success: true });
}
