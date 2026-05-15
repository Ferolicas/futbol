import { Worker, type Processor } from 'bullmq';
import { bullConnection } from './redis.js';
import { logger } from './logger.js';
import { notifyError } from './notifier.js';
import type { QueueName } from './queues.js';

// Futbol jobs
import { runFixtures } from './jobs/futbol/fixtures.js';
import { runDaily } from './jobs/futbol/daily.js';
import { runAnalyzeBatch } from './jobs/futbol/analyze-batch.js';
import { runAnalyzeAllToday } from './jobs/futbol/analyze-all-today.js';
import { runFinalize } from './jobs/futbol/finalize.js';
import { runCleanup } from './jobs/futbol/cleanup.js';
import { runLineups } from './jobs/futbol/lineups.js';
import { runLive } from './jobs/futbol/live.js';
import { runLiveCorners } from './jobs/futbol/live-corners.js';
import { runOdds } from './jobs/futbol/odds.js';

// Baseball jobs
import { runBaseballFixtures } from './jobs/baseball/fixtures.js';
import { runBaseballAnalyze } from './jobs/baseball/analyze.js';
import { runBaseballLive } from './jobs/baseball/live.js';
import { runBaseballFinalize } from './jobs/baseball/finalize.js';
import { runBaseballCleanup } from './jobs/baseball/cleanup.js';

const handlers: Record<QueueName, Processor> = {
  'futbol-fixtures':         async (job) => runFixtures(job.data),
  'futbol-daily':            async (job) => runDaily(job.data),
  // Pass the job to analyze/lineups handlers so they can call job.updateProgress()
  'futbol-analyze-batch':    async (job) => runAnalyzeBatch(job.data, job),
  'futbol-analyze-all-today':async (job) => runAnalyzeAllToday(job.data, job),
  'futbol-finalize':         async (job) => runFinalize(job.data),
  'futbol-cleanup':          async (job) => runCleanup(job.data),
  'futbol-lineups':          async (job) => runLineups(job.data, job),
  'futbol-live':             async (job) => runLive(job.data),
  'futbol-live-corners':     async (job) => runLiveCorners(job.data),
  'futbol-odds':             async (job) => runOdds(job.data),
  'baseball-fixtures':       async (job) => runBaseballFixtures(job.data),
  'baseball-analyze':        async (job) => runBaseballAnalyze(job.data, job),
  'baseball-live':           async (job) => runBaseballLive(job.data),
  'baseball-finalize':       async (job) => runBaseballFinalize(job.data),
  'baseball-cleanup':        async (job) => runBaseballCleanup(job.data),
};

// Concurrency tuning per queue. Most are I/O bound (HTTP to API-Football,
// Supabase, Upstash). Live runs every minute → keep concurrency=1 to avoid
// overlap. Analyze is heavier → leave at 2.
const concurrency: Record<QueueName, number> = {
  'futbol-fixtures':         1,
  'futbol-daily':            1,
  'futbol-analyze-batch':    2,
  'futbol-analyze-all-today':1,
  'futbol-finalize':         1,
  'futbol-cleanup':          1,
  'futbol-lineups':          1,
  'futbol-live':             1,
  'futbol-live-corners':     1,
  'futbol-odds':             1,
  'baseball-fixtures':       1,
  'baseball-analyze':        1,
  'baseball-live':           1,
  'baseball-finalize':       1,
  'baseball-cleanup':        1,
};

export function startWorkers(): Worker[] {
  const workers: Worker[] = [];
  for (const [name, handler] of Object.entries(handlers) as [QueueName, Processor][]) {
    const w = new Worker(name, handler, {
      connection: bullConnection,
      concurrency: concurrency[name],
    });
    w.on('completed', (job) => {
      logger.info({ queue: name, jobId: job.id }, 'job completed');
    });
    w.on('failed', (job, err) => {
      notifyError(
        { source: 'job', name, jobId: job?.id, extra: { attempts: job?.attemptsMade } },
        err,
      ).catch(() => {});
    });
    w.on('error', (err) => {
      notifyError({ source: 'job', name, extra: { kind: 'worker-error' } }, err).catch(() => {});
    });
    workers.push(w);
  }
  logger.info({ count: workers.length }, 'workers started');
  return workers;
}
