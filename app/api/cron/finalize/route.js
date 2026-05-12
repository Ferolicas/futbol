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
  return secret === process.env.CRON_SECRET
    || request.headers.get('x-internal-trigger') === 'true'
    || process.env.NODE_ENV !== 'production';
}

export async function GET(request) {
  if (!verifyAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await enqueue('futbol-finalize', {});
  return Response.json({ ok: true, queued: 'futbol-finalize', ...result });
}
