/**
 * POST /api/cron/analyze-batch
 * Thin enqueuer — pushes a `futbol-analyze-batch` job to the BullMQ worker.
 * Kept for backwards compatibility with manual triggers; production triggers
 * are enqueued directly by the `futbol-daily` worker job.
 */
import { enqueue } from '../../../../lib/worker-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

function verifyAuth(request) {
  // R17 FIX: eliminado el bypass forjable `x-internal-trigger`.
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret')
    || request.headers.get('authorization')?.replace('Bearer ', '');
  return secret === process.env.CRON_SECRET || process.env.NODE_ENV !== 'production';
}

export async function POST(request) {
  if (!verifyAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body = {};
  try { body = await request.json(); } catch {}
  const { offset, batchSize, date, totalFixtures } = body || {};
  if (!date) {
    return Response.json({ error: 'date required' }, { status: 400 });
  }
  const result = await enqueue('futbol-analyze-batch', { offset, batchSize, date, totalFixtures });
  return Response.json({ ok: true, queued: 'futbol-analyze-batch', ...result });
}
