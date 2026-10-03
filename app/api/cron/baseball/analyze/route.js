import { isCronAuthorized } from '@/lib/internal-auth';
/**
 * GET /api/cron/baseball/analyze
 * Thin enqueuer — pushes a `baseball-analyze` job to the BullMQ worker.
 */
import { enqueue } from '../../../../../lib/worker-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || undefined;

  const result = await enqueue('baseball-analyze', { date });
  return Response.json({ ok: true, queued: 'baseball-analyze', ...result });
}
