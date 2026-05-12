/**
 * GET /api/cron/fixtures
 * Thin enqueuer — pushes a `futbol-fixtures` job to the BullMQ worker on the VPS
 * and responds 200 immediately. All real logic lives in the worker.
 *
 * Query params:
 *   secret       CRON_SECRET (or Authorization: Bearer …)
 *   date         optional YYYY-MM-DD override
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
  const date = searchParams.get('date') || undefined;

  const result = await enqueue('futbol-fixtures', { date, forceApi: true });
  return Response.json({ ok: true, queued: 'futbol-fixtures', ...result });
}
