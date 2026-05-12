// @ts-nocheck
/**
 * Job: futbol-odds
 * Port of /api/cron/odds. Fetches odds from The Odds API for non-finished
 * fixtures of the day and pushes updates via Pusher.
 *
 * Payload: {}
 */
import { redisGet, redisSet, KEYS } from '../../../../../lib/redis.js';
import { fetchOddsForFixtures } from '../../../../../lib/odds-api.js';
import { triggerEvent } from '../../../../../lib/pusher.js';

const FINISHED = ['FT', 'AET', 'PEN', 'AWD', 'WO'];

export async function runOdds(_payload = {}) {
  if (!process.env.THE_ODDS_API_KEY) {
    throw new Error('THE_ODDS_API_KEY not configured');
  }

  const today = new Date().toISOString().split('T')[0];
  const quotaKey = `odds-quota:${today}`;
  const callsToday = (await redisGet(quotaKey)) || 0;

  const fixtures = await redisGet(KEYS.fixtures(today));
  if (!fixtures || fixtures.length === 0) {
    return { ok: true, message: 'no fixtures for today', odds: 0 };
  }

  const activeFixtures = fixtures.filter(f => !FINISHED.includes(f.fixture?.status?.short));
  if (activeFixtures.length === 0) {
    return { ok: true, message: 'all matches finished', odds: 0 };
  }

  const { oddsByFixture, apiCallsUsed, remaining } = await fetchOddsForFixtures(activeFixtures);
  const matchedCount = Object.keys(oddsByFixture).length;

  await Promise.all(
    Object.entries(oddsByFixture).map(([fixtureId, odds]) =>
      redisSet(`odds:fixture:${fixtureId}`, { ...odds, fetchedAt: new Date().toISOString() }, 86400)
    )
  );

  await redisSet(`odds:date:${today}`, oddsByFixture, 86400).catch(() => {});
  await redisSet(quotaKey, Number(callsToday) + 1, 86400).catch(() => {});

  if (matchedCount > 0) {
    await triggerEvent('live-scores', 'odds-update', {
      date: today, odds: oddsByFixture, timestamp: new Date().toISOString(),
    });
  }

  return {
    ok: true,
    matchedFixtures: matchedCount,
    totalActive: activeFixtures.length,
    apiCallsUsed,
    remaining,
    callsToday: Number(callsToday) + 1,
  };
}
