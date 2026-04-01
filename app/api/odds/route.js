/**
 * GET /api/odds
 * Returns odds from Redis cache (stored by cron/odds).
 */
import { redisGet } from '../../../lib/redis';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const fixtureId = searchParams.get('fixtureId');

  try {
    if (fixtureId) {
      const odds = await redisGet(`odds:fixture:${fixtureId}`);
      if (!odds) return Response.json({ odds: null, highProbBets: [] });
      return Response.json({ odds, fetchedAt: odds.fetchedAt });
    }

    // All odds for a date
    const oddsMap = await redisGet(`odds:date:${date}`);
    return Response.json({
      odds: oddsMap || {},
      count: Object.keys(oddsMap || {}).length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ odds: {}, error: error.message });
  }
}
