/**
 * GET /api/cron/daily
 * Reads today's fixtures from Redis cache (populated by cron/fixtures)
 * and kicks off the analyze-batch chain. Returns immediately — analysis
 * runs server-side in the background.
 * Runs at 10:05 AM Spain, 5 minutes after cron/fixtures.
 */
import { getFixtures } from '../../../../lib/api-football';
import { redisGet, redisSet } from '../../../../lib/redis';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const secret     = searchParams.get('secret') || request.headers.get('authorization')?.replace('Bearer ', '');
  const isInternal = request.headers.get('x-internal-trigger') === 'true';

  if (!isInternal && secret !== process.env.CRON_SECRET && process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const force = searchParams.get('force') === 'true';

  // Both started and completed block re-entry to prevent duplicate analysis chains
  if (!force) {
    const existing = await redisGet(`dailyBatch:${today}`);
    if (existing?.completed) {
      return Response.json({ success: true, message: 'Already completed', date: today, fixtureCount: existing.fixtureCount });
    }
    if (existing?.started) {
      return Response.json({ success: true, message: 'Already started', date: today, startedAt: existing.startedAt });
    }
  }

  // Mark as started — 24h TTL prevents re-triggers for the rest of the day
  await redisSet(`dailyBatch:${today}`, { started: true, startedAt: new Date().toISOString() }, 86400);

  try {
    // Read fixtures from Redis cache (cron/fixtures fetched + cached them 5 min ago).
    // Falls back to a fresh API call only if cache is empty.
    const { fixtures } = await getFixtures(today);
    if (!fixtures || fixtures.length === 0) {
      await redisSet(`dailyBatch:${today}`, { completed: true, fixtureCount: 0, date: today }, 86400);
      return Response.json({ success: true, date: today, fixtureCount: 0, message: 'No fixtures today' });
    }

    // Kick off the batch chain.
    // analyze-batch builds analysis:${today} incrementally (no empty-init needed).
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

    fetch(`${baseUrl}/api/cron/analyze-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-trigger': 'true' },
      body: JSON.stringify({ offset: 0, batchSize: 10, date: today, totalFixtures: fixtures.length }),
    }).catch(e => console.error('[daily] Failed to start analyze-batch chain:', e.message));

    console.log(`[daily] Analysis chain started for ${fixtures.length} fixtures on ${today}`);
    return Response.json({ success: true, date: today, fixtureCount: fixtures.length, message: 'Analysis chain started' });
  } catch (e) {
    console.error('[daily]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
