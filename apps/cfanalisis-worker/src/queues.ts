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
  // Baseball
  'baseball-fixtures',
  'baseball-analyze',
  'baseball-live',
  'baseball-finalize',
  'baseball-cleanup',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

const defaultJobOpts: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 100, age: 24 * 3600 },
  removeOnFail: { count: 200, age: 7 * 24 * 3600 },
};

export const queues: Record<QueueName, Queue> = Object.fromEntries(
  QUEUE_NAMES.map((name) => [
    name,
    new Queue(name, {
      connection: bullConnection,
      defaultJobOptions: defaultJobOpts,
    }),
  ]),
) as Record<QueueName, Queue>;

export function isValidQueue(name: string): name is QueueName {
  return (QUEUE_NAMES as readonly string[]).includes(name);
}
