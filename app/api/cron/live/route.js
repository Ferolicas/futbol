/**
 * GET /api/cron/live
 * Thin enqueuer — pushes a `futbol-live` job to the BullMQ worker.
 */
import { enqueue } from '../../../../lib/worker-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

function verifyAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret')
    || request.headers.get('authorization')?.replace('Bearer ', '');
  // R17 FIX: eliminado el bypass por header `x-internal-trigger` (cualquiera podía
  // ponerlo y saltarse el CRON_SECRET). Los triggers internos ahora pasan el secret.
  return secret === process.env.CRON_SECRET
    || process.env.NODE_ENV !== 'production';
}

export async function GET(request) {
  if (!verifyAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await enqueue('futbol-live', {});
  return Response.json({ ok: true, queued: 'futbol-live', ...result });
}
