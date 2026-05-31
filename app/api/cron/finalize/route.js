/**
 * GET /api/cron/finalize
 * Thin enqueuer — pushes a `futbol-finalize` job to the BullMQ worker.
 */
import { enqueue } from '../../../../lib/worker-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

function verifyAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret')
    || request.headers.get('authorization')?.replace('Bearer ', '');
  // R17 FIX: eliminado el bypass forjable por header `x-internal-trigger`.
  // R18 FIX: eliminado el bypass `NODE_ENV !== 'production'`. Siempre CRON_SECRET.
  return secret === process.env.CRON_SECRET;
}

export async function GET(request) {
  if (!verifyAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await enqueue('futbol-finalize', {});
  return Response.json({ ok: true, queued: 'futbol-finalize', ...result });
}
