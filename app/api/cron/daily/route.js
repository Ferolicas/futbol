import { isCronAuthorized } from '@/lib/internal-auth';
/**
 * GET /api/cron/daily
 * Thin enqueuer — pushes a `futbol-daily` job to the BullMQ worker.
 */
import { enqueue } from '../../../../lib/worker-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || undefined;
  const force = searchParams.get('force') === 'true';

  const result = await enqueue('futbol-daily', { date, force });
  return Response.json({ ok: true, queued: 'futbol-daily', ...result });
}
