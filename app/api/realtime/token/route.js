import { signRealtimeAccessToken } from '@cfanalisis/realtime-protocol/auth';
import { getCurrentUser } from '../../../../lib/auth-pg';
import { pgQuery } from '../../../../lib/db';
import { jsonError } from '../../../../lib/api-error';
import { redisRateLimit } from '../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

const PRIVATE_NO_STORE = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
};

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: PRIVATE_NO_STORE });
    }
    const limit = await redisRateLimit('realtime-token', user.id, 20, 60);
    if (!limit.success) {
      return Response.json({ error: 'Too many requests' }, { status: 429, headers: PRIVATE_NO_STORE });
    }
    const { rows } = await pgQuery(
      'SELECT role FROM public.user_profiles WHERE id = $1 LIMIT 1',
      [user.id],
    );
    const workerSecret = process.env.WORKER_SECRET;
    if (!workerSecret || workerSecret.length < 32) {
      return Response.json({ error: 'Realtime unavailable' }, { status: 503, headers: PRIVATE_NO_STORE });
    }
    const access = await signRealtimeAccessToken({
      userId: user.id,
      role: rows[0]?.role,
      workerSecret,
    });
    return Response.json({
      token: access.token,
      expiresAt: new Date(access.expiresAt).toISOString(),
    }, { headers: PRIVATE_NO_STORE });
  } catch (error) {
    return jsonError(error);
  }
}
