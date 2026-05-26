// @ts-nocheck
/**
 * Job: futbol-fixtures
 * Port of /api/cron/fixtures (GET). Fetches fixtures for target date, caches in
 * Redis + Supabase, saves matchSchedule for live/lineups.
 *
 * Payload: { date?: 'YYYY-MM-DD', forceApi?: boolean }
 */
import { getFixtures, getQuota, saveMatchSchedule, cacheFixtures, redisSet, KEYS, cronTargetDate } from '../../shared.js';

export async function runFixtures(payload = {}) {
  // cronTargetDate() = jornada Bogotá objetivo (día siguiente de Bogotá a la
  // hora del cron de las 02:10 Madrid). daily.js usa la MISMA función, así
  // garantizamos que se analice exactamente el día que aquí se cachea.
  const targetDate = payload.date || cronTargetDate();
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
