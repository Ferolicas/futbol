import { isCronAuthorized } from '@/lib/internal-auth';
/**
 * GET /api/cron/live
 * Thin enqueuer — pushes a `futbol-live` job to the BullMQ worker.
 */
import { enqueue } from '../../../../lib/worker-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await enqueue('futbol-live', {});
  return Response.json({ ok: true, queued: 'futbol-live', ...result });
}
