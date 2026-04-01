/**
 * GET /api/cron/odds
 * Fetches odds from The Odds API and stores them in Redis.
 */
import { redisGet, redisSet, KEYS } from '../../../../lib/redis';
import { fetchOddsForFixtures } from '../../../../lib/odds-api';
import { triggerEvent } from '../../../../lib/pusher';

export const dynamic = 'force-dynamic';
export const maxDuration = 55;

function verifyCronAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret')
    || request.headers.get('authorization')?.replace('Bearer ', '');
  return secret === process.env.CRON_SECRET || process.env.NODE_ENV !== 'production';
}

export async function GET(request) {
  if (!verifyCronAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!process.env.THE_ODDS_API_KEY) {
    return Response.json({ error: 'THE_ODDS_API_KEY not configured' }, { status: 500 });
  }

  try {
    const today = new Date().toISOString().split('T')[0];

    // Track calls today
    const quotaKey = `odds-quota:${today}`;
    const callsToday = (await redisGet(quotaKey)) || 0;

    // Get today's fixtures from Redis
    const fixtures = await redisGet(KEYS.fixtures(today));
    if (!fixtures || fixtures.length === 0) {
      return Response.json({ success: true, message: 'No fixtures for today', odds: 0 });
    }

    const FINISHED = ['FT', 'AET', 'PEN', 'AWD', 'WO'];
    const activeFixtures = fixtures.filter(f => !FINISHED.includes(f.fixture?.status?.short));

    if (activeFixtures.length === 0) {
      return Response.json({ success: true, message: 'All matches finished', odds: 0 });
    }

    const { oddsByFixture, apiCallsUsed, remaining } = await fetchOddsForFixtures(activeFixtures);
    const matchedCount = Object.keys(oddsByFixture).length;

    // Save each fixture's odds to Redis (24h TTL)
    await Promise.all(
      Object.entries(oddsByFixture).map(([fixtureId, odds]) =>
        redisSet(`odds:fixture:${fixtureId}`, { ...odds, fetchedAt: new Date().toISOString() }, 86400)
      )
    );

    // Save full date odds map
    await redisSet(`odds:date:${today}`, oddsByFixture, 86400).catch(() => {});

    // Track daily usage
    await redisSet(quotaKey, Number(callsToday) + 1, 86400).catch(() => {});

    // Push update to open dashboards
    if (matchedCount > 0) {
      await triggerEvent('live-scores', 'odds-update', {
        date: today, odds: oddsByFixture, timestamp: new Date().toISOString(),
      });
    }

    return Response.json({
      success: true,
      matchedFixtures: matchedCount,
      totalActive: activeFixtures.length,
      apiCallsUsed,
      remaining,
      callsToday: Number(callsToday) + 1,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[ODDS-CRON]', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
