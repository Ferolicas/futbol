import { redisGet, KEYS } from '../../../lib/redis';
import { getFromSanity } from '../../../lib/sanity';

// Live poll: reads from Redis (populated by cron/live every minute).
// Also supports loading stats for specific finished matches from Redis/Sanity.
// NO direct API-Football calls.

export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date') || new Date().toISOString().split('T')[0];
    const fixtureId = searchParams.get('fixtureId');

    // If a specific fixture is requested, try to get its stats directly
    if (fixtureId) {
      let stats = await redisGet(KEYS.fixtureStats(fixtureId));
      if (!stats) {
        stats = await getFromSanity('liveMatchStats', fixtureId);
      }
      return Response.json({
        liveStats: stats ? [stats] : [],
        timestamp: stats?.updatedAt || new Date().toISOString(),
        source: stats ? 'redis-or-sanity' : 'empty',
      }, {
        headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
      });
    }

    // Read aggregated live stats from Redis (includes live + recently-finished)
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
