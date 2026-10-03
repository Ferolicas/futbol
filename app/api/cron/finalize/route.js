import { isCronAuthorized } from '@/lib/internal-auth';
/**
 * GET /api/cron/finalize
 * Thin enqueuer — pushes a `futbol-finalize` job to the BullMQ worker.
 */
import { enqueue } from '../../../../lib/worker-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date');
  const fixtureIds = (searchParams.get('fixture_ids') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .slice(0, 100);
  const refreshStats = searchParams.get('refresh_stats') === '1';

  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: 'date must use YYYY-MM-DD' }, { status: 400 });
  }
  if (refreshStats && fixtureIds.length === 0) {
    return Response.json({ error: 'fixture_ids is required for refresh_stats' }, { status: 400 });
  }

  const payload = {
    ...(date ? { date } : {}),
    ...(fixtureIds.length ? { fixtureIds } : {}),
    ...(refreshStats ? { refreshStats: true } : {}),
  };
  const result = await enqueue('futbol-finalize', payload);
  return Response.json({ ok: true, queued: 'futbol-finalize', ...result });
}
