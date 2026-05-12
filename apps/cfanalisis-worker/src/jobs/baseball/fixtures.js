// @ts-nocheck
/**
 * Job: baseball-fixtures
 * Port of /api/cron/baseball/fixtures. Fetches MLB fixtures and saves schedule.
 *
 * Payload: { date?: 'YYYY-MM-DD' }
 */
import { getBaseballFixturesByDate, getBaseballQuota } from '../../../../../lib/api-baseball.js';
import { supabaseAdmin } from '../../../../../lib/supabase.js';

export async function runBaseballFixtures(payload = {}) {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const todayUTC = now.toISOString().split('T')[0];
  const tomorrowUTC = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
  const targetDate = payload.date || (utcHour >= 22 ? tomorrowUTC : todayUTC);

  const result = await getBaseballFixturesByDate(targetDate, { forceApi: true });
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
  return { ok: true, targetDate, fixtureCount: fixtures.length, quota };
}
