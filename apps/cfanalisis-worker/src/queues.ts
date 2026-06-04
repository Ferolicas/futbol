import { Queue, type JobsOptions } from 'bullmq';
import { bullConnection } from './redis.js';

// One queue per cron type — allows per-queue scaling, priorities, and metrics.
export const QUEUE_NAMES = [
  // Futbol
  'futbol-fixtures',
  'futbol-daily',
  'futbol-analyze-batch',
  'futbol-analyze-all-today',
  'futbol-finalize',
  'futbol-cleanup',
  'futbol-lineups',
  'futbol-live',
  'futbol-live-corners',
  'futbol-odds',
  'futbol-raw-backfill',
  'futbol-retrain',
  'futbol-watchdog',
  // Baseball
  'baseball-fixtures',
  'baseball-analyze',
  'baseball-analyze-all-today',
  'baseball-live',
  'baseball-finalize',
  'baseball-cleanup',
  'baseball-calibrate',
  'baseball-retrain',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

const defaultJobOpts: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 100, age: 24 * 3600 },
  removeOnFail: { count: 200, age: 7 * 24 * 3600 },
};

// Heavy analysis / data-integrity jobs deserve more retries. Each retry of
// analyze-batch reanalyzes only the previously-failed fixtures (cached ones
// short-circuit), so 5 attempts × exponential backoff almost guarantees full
// coverage even through API hiccups.
const analyzeJobOpts: JobsOptions = {
  ...defaultJobOpts,
  attempts: 5,
  backoff: { type: 'exponential', delay: 10000 },
};

// High-frequency live polls — don't retry forever, they'll fire again soon
// anyway. Fail fast and let the next minute's cron try.
const liveJobOpts: JobsOptions = {
  ...defaultJobOpts,
  attempts: 1,
};

const opts: Record<QueueName, JobsOptions> = {
  'futbol-fixtures':         defaultJobOpts,
  'futbol-daily':            defaultJobOpts,
  'futbol-analyze-batch':    analyzeJobOpts,
  'futbol-analyze-all-today':analyzeJobOpts,
  'futbol-finalize':         analyzeJobOpts,
  'futbol-cleanup':          defaultJobOpts,
  'futbol-lineups':          defaultJobOpts,
  'futbol-live':             liveJobOpts,
  'futbol-live-corners':     liveJobOpts,
  'futbol-odds':             defaultJobOpts,
  'futbol-raw-backfill':     { ...defaultJobOpts, attempts: 1 },
  // Ciclo nocturno de auto-mejora (capture→reenrich→profiles→train). Los 4
  // pasos son idempotentes, así que reintentar es seguro; pero cada intento
  // re-corre todo el ciclo pesado → tope 2 intentos.
  'futbol-retrain':          { ...defaultJobOpts, attempts: 2 },
  // Watchdog (dead-man's switch): chequeo ligero diario; default opts.
  'futbol-watchdog':         defaultJobOpts,
  'baseball-fixtures':            defaultJobOpts,
  'baseball-analyze':             analyzeJobOpts,
  'baseball-analyze-all-today':   analyzeJobOpts,
  'baseball-live':                liveJobOpts,
  'baseball-finalize':            analyzeJobOpts,
  'baseball-cleanup':             defaultJobOpts,
  'baseball-calibrate':           defaultJobOpts,
  // Retrain ML — reenrich + train, idempotente. attempts:2 acotado.
  'baseball-retrain':             { ...defaultJobOpts, attempts: 2 },
};

export const queues: Record<QueueName, Queue> = Object.fromEntries(
  QUEUE_NAMES.map((name) => [
    name,
    new Queue(name, {
      connection: bullConnection,
      defaultJobOptions: opts[name],
    }),
  ]),
) as Record<QueueName, Queue>;

export function isValidQueue(name: string): name is QueueName {
  return (QUEUE_NAMES as readonly string[]).includes(name);
}
