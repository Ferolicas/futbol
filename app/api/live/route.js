import { redisGet, KEYS } from '../../../lib/redis';

// Live state: reads from Redis (populated by cron/live every minute).
// NO direct API-Football calls — saves quota for the cron.

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date');

  if (!date) {
    return Response.json({ error: 'date parameter required' }, { status: 400 });
  }

  try {
    // Read live stats from Redis (written by cron/live every minute)
    const liveData = await redisGet(KEYS.liveStats(date));

    if (liveData && typeof liveData === 'object') {
      const matches = Object.values(liveData);
      return Response.json({
        matches,
        allCount: matches.length,
        source: 'redis',
        updatedAt: matches[0]?.updatedAt || new Date().toISOString(),
      }, {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });
    }

    // No live data in Redis — no matches are live
    return Response.json({
      matches: [],
      allCount: 0,
      source: 'redis-empty',
      updatedAt: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[LIVE] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
