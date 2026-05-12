/**
 * POST/GET /api/cron/analyze-all-today
 * Thin enqueuer — pushes a `futbol-analyze-all-today` job to the BullMQ worker.
 */
import { enqueue } from '../../../../lib/worker-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

function verifyAuth(request) {
  const secret = request.headers.get('x-cron-secret')
    || request.headers.get('authorization')?.replace('Bearer ', '')
    || new URL(request.url).searchParams.get('secret');
  return secret === process.env.CRON_SECRET || process.env.NODE_ENV !== 'production';
}

async function run(request) {
  if (!verifyAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || undefined;
  const force = searchParams.get('force') === 'true';

  const result = await enqueue('futbol-analyze-all-today', { date, force });
  return Response.json({ ok: true, queued: 'futbol-analyze-all-today', ...result });
}

export const GET = run;
export const POST = run;
