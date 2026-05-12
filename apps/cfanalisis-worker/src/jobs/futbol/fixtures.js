// @ts-nocheck
/**
 * Job: futbol-fixtures
 * Port of /api/cron/fixtures (GET). Fetches fixtures for target date, caches in
 * Redis + Supabase, saves matchSchedule for live/lineups.
 *
 * Payload: { date?: 'YYYY-MM-DD', forceApi?: boolean }
 */
import { getFixtures, getQuota } from '../../../../../lib/api-football.js';
import { saveMatchSchedule } from '../../../../../lib/supabase-cache.js';
import { cacheFixtures } from '../../../../../lib/sanity-cache.js';
import { redisSet, KEYS } from '../../../../../lib/redis.js';

export async function runFixtures(payload = {}) {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const todayUTC    = now.toISOString().split('T')[0];
  const tomorrowUTC = new Date(now.getTime() + 86400000).toISOString().split('T')[0];

  const targetDate = payload.date || (utcHour >= 22 ? tomorrowUTC : todayUTC);
  console.log(`[job:futbol-fixtures] target=${targetDate}`);

  const result   = await getFixtures(targetDate, { forceApi: payload.forceApi ?? true });
  const fixtures = result.fixtures || [];

  if (fixtures.length > 0) {
    await cacheFixtures(targetDate, fixtures);
    await redisSet(KEYS.fixtures(targetDate), fixtures, 7200);
  }

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

  const quota = await getQuota();
  return { ok: true, targetDate, fixtureCount: fixtures.length, quota };
}
