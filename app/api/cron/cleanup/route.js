/**
 * GET /api/cron/cleanup
 * Thin enqueuer — pushes a `futbol-cleanup` job to the BullMQ worker.
 */
import { enqueue } from '../../../../lib/worker-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

function verifyAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret')
    || request.headers.get('authorization')?.replace('Bearer ', '');
  return secret === process.env.CRON_SECRET || process.env.NODE_ENV !== 'production';
}

export async function GET(request) {
  if (!verifyAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const purge = searchParams.get('purge') === 'true';

  const result = await enqueue('futbol-cleanup', { purge });
  return Response.json({ ok: true, queued: 'futbol-cleanup', ...result });
}
