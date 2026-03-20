import { redisGet, KEYS } from '../../../lib/redis';

// Live poll: reads from Redis (populated by cron/live every minute).
// NO direct API-Football calls.

export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date') || new Date().toISOString().split('T')[0];

    // Read live stats from Redis
    const liveData = await redisGet(KEYS.liveStats(date));

    if (liveData && typeof liveData === 'object') {
      const liveStats = Object.values(liveData);
      return Response.json({
        liveStats,
        timestamp: liveStats[0]?.updatedAt || new Date().toISOString(),
        source: 'redis',
      }, {
        headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
      });
    }

    return Response.json({
      liveStats: [],
      timestamp: new Date().toISOString(),
      source: 'redis-empty',
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return Response.json({ liveStats: [], error: error.message });
  }
}
