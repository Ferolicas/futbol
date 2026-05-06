/**
 * GET /api/cron/baseball/fixtures
 * Fetches baseball fixtures for target date, caches in Redis + Supabase.
 * Cost: 1 API call per execution.
 *
 * Schedule (cron-job.org, UTC): "0 1 * * *"  (3:00 AM España CEST — 1h after football)
 * ?date=YYYY-MM-DD overrides target date.
 */
import { getBaseballFixturesByDate, getBaseballQuota } from '../../../../../lib/api-baseball';
import { supabaseAdmin } from '../../../../../lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function verifyAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret') || request.headers.get('authorization')?.replace('Bearer ', '');
  return secret === process.env.CRON_SECRET || process.env.NODE_ENV !== 'production';
}

export async function GET(request) {
  if (!verifyAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const now = new Date();
    const utcHour = now.getUTCHours();
    const todayUTC = now.toISOString().split('T')[0];
    const tomorrowUTC = new Date(now.getTime() + 86400000).toISOString().split('T')[0];

    const targetDate = searchParams.get('date') || (utcHour >= 22 ? tomorrowUTC : todayUTC);

    console.log(`[CRON:baseball/fixtures] target=${targetDate}`);
    const result = await getBaseballFixturesByDate(targetDate, { forceApi: true });

    // Build schedule for live cron
    const fixtures = result.fixtures || [];
    const kickoffTimes = fixtures.map(f => {
      const kickoff = new Date(f.date || f.fixture?.date).getTime();
      return { fixtureId: f.id || f.fixture?.id, kickoff, expectedEnd: kickoff + 210 * 60 * 1000 };
    }).sort((a, b) => a.kickoff - b.kickoff);

    const scheduleData = {
      kickoffTimes,
      firstKickoff: kickoffTimes[0]?.kickoff || null,
      lastExpectedEnd: kickoffTimes.length > 0 ? Math.max(...kickoffTimes.map(k => k.expectedEnd)) : null,
      fixtureCount: fixtures.length,
    };

    await supabaseAdmin
      .from('baseball_match_schedule')
      .upsert({ date: targetDate, schedule: scheduleData, updated_at: new Date().toISOString() });

    const quota = await getBaseballQuota();
    return Response.json({
      success: true,
      targetDate,
      fixtureCount: fixtures.length,
      quota,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[CRON:baseball/fixtures]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
