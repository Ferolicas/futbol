import { getFixtures, getQuota } from '../../../../lib/api-football';
import { saveToSanity } from '../../../../lib/sanity';

// Cron: runs at 10:00 AM Spain time (08:00 UTC)
// cron-job.org: GET /api/cron/fixtures?secret=CRON_SECRET

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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

  try {
    const today = new Date().toISOString().split('T')[0];
    console.log(`[CRON] Loading fixtures for ${today}...`);

    const result = await getFixtures(today);
    const fixtures = result.fixtures || [];

    // Generate matchSchedule so live/lineups crons can skip intelligently
    if (fixtures.length > 0) {
      const kickoffTimes = fixtures.map(f => {
        const kickoff = new Date(f.fixture.date).getTime();
        return {
          fixtureId: f.fixture.id,
          kickoff,
          expectedEnd: kickoff + 120 * 60 * 1000,
        };
      }).sort((a, b) => a.kickoff - b.kickoff);

      const firstKickoff = kickoffTimes[0].kickoff;
      const lastExpectedEnd = Math.max(...kickoffTimes.map(k => k.expectedEnd));

      await saveToSanity('matchSchedule', today, {
        date: today,
        firstKickoff,
        lastExpectedEnd,
        kickoffTimes,
        fixtureCount: fixtures.length,
        createdAt: new Date().toISOString(),
      });
      console.log(`[CRON] matchSchedule saved: ${fixtures.length} matches`);
    } else {
      await saveToSanity('matchSchedule', today, {
        date: today,
        firstKickoff: null,
        lastExpectedEnd: null,
        kickoffTimes: [],
        fixtureCount: 0,
        createdAt: new Date().toISOString(),
      });
      console.log('[CRON] matchSchedule saved: 0 matches');
    }

    const quota = await getQuota();
    let tomorrowCount = 0;

    // Always fetch tomorrow's fixtures — quota is not a concern
    {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowDate = tomorrow.toISOString().split('T')[0];

      try {
        const tResult = await getFixtures(tomorrowDate);
        tomorrowCount = tResult.fixtures?.length || 0;
      } catch (e) {
        console.error('[CRON] Tomorrow fetch failed:', e.message);
      }
    }

    const finalQuota = await getQuota();

    return Response.json({
      success: true,
      date: today,
      fixtureCount: fixtures.length,
      tomorrowCount,
      quota: finalQuota,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[CRON] Fixtures error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
