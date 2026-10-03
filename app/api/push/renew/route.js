import { z } from 'zod';
import { pgQuery } from '../../../../lib/db';
import { redisRateLimit, clientIp } from '../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

const endpointSchema = z.string().url().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}, 'Invalid endpoint');

const subscriptionSchema = z.object({
  endpoint: endpointSchema,
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(16).max(512),
    auth: z.string().min(8).max(256),
  }).strict(),
}).strict();

const schema = z.object({ oldEndpoint: endpointSchema, subscription: subscriptionSchema }).strict();

function toArray(stored) {
  if (!stored) return [];
  return Array.isArray(stored) ? stored : [stored];
}

export async function POST(request) {
  const limit = await redisRateLimit('push-renew', clientIp(request), 10, 60, { failClosed: true });
  if (!limit.success) {
    return Response.json({ error: 'Too many requests' }, { status: limit.available ? 429 : 503 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid payload' }, { status: 400 });
  const { oldEndpoint, subscription: newSub } = parsed.data;

  try {
    const result = await pgQuery(
      `SELECT user_id, subscription
         FROM public.push_subscriptions
        WHERE EXISTS (
          SELECT 1
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(subscription) = 'array'
                   THEN subscription ELSE jsonb_build_array(subscription) END
            ) AS item
           WHERE item->>'endpoint' = $1
        )
        LIMIT 1`,
      [oldEndpoint],
    );
    const target = result.rows[0];
    if (!target) return Response.json({ renewed: false });

    const updated = [
      ...toArray(target.subscription).filter(
        item => item?.endpoint !== oldEndpoint && item?.endpoint !== newSub.endpoint,
      ).slice(-4),
      newSub,
    ];
    await pgQuery(
      'UPDATE public.push_subscriptions SET subscription = $1::jsonb WHERE user_id = $2',
      [JSON.stringify(updated), target.user_id],
    );
    return Response.json({ renewed: true, deviceCount: updated.length });
  } catch (error) {
    console.error('[push:renew]', error.message);
    return Response.json({ error: 'DB error' }, { status: 500 });
  }
}
