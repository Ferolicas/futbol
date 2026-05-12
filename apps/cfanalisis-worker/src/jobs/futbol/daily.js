// @ts-nocheck
/**
 * Job: futbol-daily
 * Port of /api/cron/daily. Reads today's fixtures from cache and enqueues
 * a single futbol-analyze-batch job for the whole day (no chaining needed
 * since the worker has no time limit).
 *
 * Payload: { date?: 'YYYY-MM-DD', force?: boolean }
 */
import { getFixtures, redisGet, redisSet } from '../../shared.js';
import { queues } from '../../queues.js';

export async function runDaily(payload = {}) {
  const today = payload.date || new Date().toISOString().split('T')[0];
  const force = payload.force === true;

  if (!force) {
    const existing = await redisGet(`dailyBatch:${today}`);
    if (existing?.completed) {
      return { ok: true, message: 'already completed', date: today, fixtureCount: existing.fixtureCount };
    }
    if (existing?.started) {
      return { ok: true, message: 'already started', date: today, startedAt: existing.startedAt };
    }
  }

  await redisSet(`dailyBatch:${today}`, { started: true, startedAt: new Date().toISOString() }, 86400);

  const { fixtures } = await getFixtures(today);
  if (!fixtures || fixtures.length === 0) {
    await redisSet(`dailyBatch:${today}`, { completed: true, fixtureCount: 0, date: today }, 86400);
    return { ok: true, date: today, fixtureCount: 0, message: 'no fixtures' };
  }

  // No HTTP chain — enqueue a single batch job. The worker has no time limit so
  // analyze-batch processes the entire fixture list in one go (or in chunks if
  // it chooses to).
  const job = await queues['futbol-analyze-batch'].add('analyze-batch', {
    offset: 0,
    batchSize: 10,
    date: today,
    totalFixtures: fixtures.length,
  });

  return { ok: true, date: today, fixtureCount: fixtures.length, batchJobId: job.id };
}
