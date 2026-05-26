// @ts-nocheck
/**
 * Job: futbol-daily
 * Port of /api/cron/daily. Reads today's fixtures from cache and enqueues
 * a single futbol-analyze-batch job for the whole day (no chaining needed
 * since the worker has no time limit).
 *
 * Payload: { date?: 'YYYY-MM-DD', force?: boolean }
 */
import { getFixtures, redisGet, redisSet, cronTargetDate } from '../../shared.js';
import { queues } from '../../queues.js';

// Ventana de gracia del flag `started`. Un batch en curso legítimo no debe
// re-encolarse; pero un `started` huérfano (el proceso murió tras marcarlo y
// antes de encolar analyze-batch, o el batch falló) bloqueaba el día entero
// (TTL 24h). Pasada esta ventana sin `completed`, lo tratamos como stale y
// re-encolamos — analyze-batch es idempotente (fromCache) así que reintentar
// es barato y nunca duplica análisis ya hechos.
const STARTED_GRACE_MS = 20 * 60 * 1000;

export async function runDaily(payload = {}) {
  // cronTargetDate(): jornada Bogotá que prepara fixtures.js (el día siguiente
  // de Bogotá a la hora del cron). Antes daily usaba "hoy Bogotá" y miraba un
  // día por detrás → veía dailyBatch del día anterior ya completado y nunca
  // encolaba analyze-batch del día que fixtures acababa de cachear.
  const today = payload.date || cronTargetDate();
  const force = payload.force === true;

  if (!force) {
    const existing = await redisGet(`dailyBatch:${today}`);
    if (existing?.completed) {
      return { ok: true, message: 'already completed', date: today, fixtureCount: existing.fixtureCount };
    }
    if (existing?.started) {
      const startedMs = existing.startedAt ? Date.parse(existing.startedAt) : 0;
      const ageMs = startedMs ? Date.now() - startedMs : Infinity;
      if (startedMs && ageMs < STARTED_GRACE_MS) {
        return { ok: true, message: 'already started', date: today, startedAt: existing.startedAt };
      }
      // started huérfano/stale → caemos a re-encolar (no bloqueamos el día).
      console.warn(`[job:futbol-daily] dailyBatch:${today} marcado started hace ${Number.isFinite(ageMs) ? Math.round(ageMs / 60000) + 'min' : '∞'} sin completar → re-encolando analyze-batch`);
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
