/**
 * GET /api/cron/fixtures
 * Fetches fixtures for the target date, caches in Redis + Supabase,
 * and saves matchSchedule for the live/lineups crons.
 *
 * Target date logic:
 *   - If UTC hour >= 22 (= midnight Spain CEST): fetch TOMORROW UTC
 *     so users see the next day's matches as soon as midnight hits.
 *   - Otherwise: fetch TODAY UTC (manual triggers, fallback).
 *   - ?date=YYYY-MM-DD param always overrides both.
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
    const { searchParams } = new URL(request.url);

    // Auto-detect target date.
    // At 22:00+ UTC (= midnight Spain CEST / 23:00 CET), fetch tomorrow UTC
    // so the next day's fixtures are cached the moment Spain's date flips.
    const now = new Date();
    const utcHour = now.getUTCHours();
    const todayUTC    = now.toISOString().split('T')[0];
    const tomorrowUTC = new Date(now.getTime() + 86400000).toISOString().split('T')[0];

    const targetDate = searchParams.get('date')
      || (utcHour >= 22 ? tomorrowUTC : todayUTC);

    console.log(`[CRON:fixtures] UTC hour=${utcHour} → fetching fixtures for ${targetDate}`);

    const result   = await getFixtures(targetDate, { forceApi: true });
    const fixtures = result.fixtures || [];

    // Cache in Redis + Supabase
    if (fixtures.length > 0) {
      await cacheFixtures(targetDate, fixtures);
      await redisSet(KEYS.fixtures(targetDate), fixtures, 7200);
    }

    // Build matchSchedule for live/lineups crons
    const kickoffTimes = fixtures.map(f => {
      const kickoff = new Date(f.fixture.date).getTime();
      return { fixtureId: f.fixture.id, kickoff, expectedEnd: kickoff + 120 * 60 * 1000 };
    }).sort((a, b) => a.kickoff - b.kickoff);

    const scheduleData = {
      kickoffTimes,
      firstKickoff:    kickoffTimes[0]?.kickoff || null,
      lastExpectedEnd: kickoffTimes.length > 0 ? Math.max(...kickoffTimes.map(k => k.expectedEnd)) : null,
      fixtureCount:    fixtures.length,
    };

    await saveMatchSchedule(targetDate, scheduleData);
    console.log(`[CRON:fixtures] matchSchedule saved for ${targetDate}: ${fixtures.length} matches`);

    const quota = await getQuota();
    return Response.json({
      success: true,
      targetDate,
      fixtureCount: fixtures.length,
      quota,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[CRON:fixtures] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
