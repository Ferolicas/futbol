/**
 * GET /api/cron/fixtures
 * Runs at 10AM Spain (08:00 UTC): fetch today's fixtures, save to Redis + Supabase.
 * Also generates matchSchedule for live/lineups crons.
 */
import { getFixtures, getQuota } from '../../../../lib/api-football';
import { saveMatchSchedule } from '../../../../lib/supabase-cache';
import { cacheFixtures } from '../../../../lib/sanity-cache';
import { redisSet, KEYS } from '../../../../lib/redis';

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
    console.log(`[CRON:fixtures] Loading fixtures for ${today}...`);

    const result = await getFixtures(today, { forceApi: true });
    const fixtures = result.fixtures || [];

    // Cache fixtures in Redis + Supabase
    if (fixtures.length > 0) {
      await cacheFixtures(today, fixtures);
      await redisSet(KEYS.fixtures(today), fixtures, 7200);
    }

    // Generate matchSchedule for live/lineups crons
    const kickoffTimes = fixtures.map(f => {
      const kickoff = new Date(f.fixture.date).getTime();
      return { fixtureId: f.fixture.id, kickoff, expectedEnd: kickoff + 120 * 60 * 1000 };
    }).sort((a, b) => a.kickoff - b.kickoff);

    const scheduleData = {
      kickoffTimes,
      firstKickoff: kickoffTimes[0]?.kickoff || null,
      lastExpectedEnd: kickoffTimes.length > 0 ? Math.max(...kickoffTimes.map(k => k.expectedEnd)) : null,
      fixtureCount: fixtures.length,
    };

    await saveMatchSchedule(today, scheduleData);
    console.log(`[CRON:fixtures] matchSchedule saved: ${fixtures.length} matches`);

    // Also fetch tomorrow's fixtures (cache warming)
    let tomorrowCount = 0;
    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowDate = tomorrow.toISOString().split('T')[0];
      const tResult = await getFixtures(tomorrowDate);
      tomorrowCount = tResult.fixtures?.length || 0;
    } catch (e) {
      console.error('[CRON:fixtures] Tomorrow fetch failed:', e.message);
    }

    const quota = await getQuota();
    return Response.json({
      success: true,
      date: today,
      fixtureCount: fixtures.length,
      tomorrowCount,
      quota,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[CRON:fixtures] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
