import { getFromSanity, saveToSanity } from '../../../../lib/sanity';
import { fetchOddsForFixtures } from '../../../../lib/odds-api';
import { triggerEvent } from '../../../../lib/pusher';

// Cron: fetches odds from The Odds API
// cron-job.org: GET /api/cron/odds?secret=CRON_SECRET

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

    const quotaDoc = await getFromSanity('appConfig', `oddsQuota-${today}`);
    const callsToday = quotaDoc?.calls || 0;

    // Get today's fixtures from Sanity cache
    const cached = await getFromSanity('footballFixturesCache', today);
    const fixtures = cached?.fixtures || [];

    if (fixtures.length === 0) {
      return Response.json({ success: true, message: 'No fixtures for today', odds: 0 });
    }

    // Only fetch odds for matches not yet finished
    const FINISHED = ['FT', 'AET', 'PEN', 'AWD', 'WO'];
    const activeFixtures = fixtures.filter(f =>
      !FINISHED.includes(f.fixture?.status?.short)
    );

    if (activeFixtures.length === 0) {
      return Response.json({ success: true, message: 'All matches finished', odds: 0 });
    }

    // Fetch odds from The Odds API
    const { oddsByFixture, apiCallsUsed, remaining } = await fetchOddsForFixtures(activeFixtures);

    const matchedCount = Object.keys(oddsByFixture).length;

    // Save odds to Sanity for each fixture
    const savePromises = Object.entries(oddsByFixture).map(([fixtureId, odds]) =>
      saveToSanity('oddsCache', `odds-${fixtureId}`, {
        fixtureId: Number(fixtureId),
        date: today,
        odds,
        source: 'the-odds-api',
        fetchedAt: new Date().toISOString(),
      })
    );
    await Promise.all(savePromises);

    // Track daily usage
    await saveToSanity('appConfig', `oddsQuota-${today}`, {
      date: today,
      calls: callsToday + 1,
      lastCallAt: new Date().toISOString(),
      remaining,
    });

    // Push odds update via Pusher so open dashboards get fresh odds
    if (matchedCount > 0) {
      await triggerEvent('live-scores', 'odds-update', {
        date: today,
        odds: oddsByFixture,
        timestamp: new Date().toISOString(),
      });
    }

    return Response.json({
      success: true,
      matchedFixtures: matchedCount,
      totalActive: activeFixtures.length,
      apiCallsUsed,
      remaining,
      callsToday: callsToday + 1,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[ODDS-CRON] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
