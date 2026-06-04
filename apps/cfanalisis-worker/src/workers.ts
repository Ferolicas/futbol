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
import { runRawBackfillJob } from './jobs/futbol/raw-backfill.js';
import { runFutbolRetrain } from './jobs/futbol/retrain.js';
import { runWatchdog } from './jobs/futbol/watchdog.js';

// Baseball jobs
import { runBaseballFixtures } from './jobs/baseball/fixtures.js';
import { runBaseballAnalyze } from './jobs/baseball/analyze.js';
import { runBaseballLive } from './jobs/baseball/live.js';
import { runBaseballFinalize } from './jobs/baseball/finalize.js';
import { runBaseballCleanup } from './jobs/baseball/cleanup.js';
import { runBaseballRetrain } from './jobs/baseball/retrain.js';
import { runBaseballCalibration } from './jobs/calibration/baseball.js';

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
  'futbol-raw-backfill':     async (job) => runRawBackfillJob(job.data),
  'futbol-retrain':          async (job) => runFutbolRetrain(job.data),
  'futbol-watchdog':         async (job) => runWatchdog(job.data),
  'baseball-fixtures':            async (job) => runBaseballFixtures(job.data),
  'baseball-analyze':             async (job) => runBaseballAnalyze(job.data, job),
  // analyze-all-today: mismo handler que analyze pero forzando force=true.
  // Gemelo de futbol-analyze-all-today. Lo invoca el botón "Re-analizar
  // baseball" del panel /ferney (POST a /admin/retry con payload {force:true}).
  'baseball-analyze-all-today':   async (job) => runBaseballAnalyze({ ...(job.data || {}), force: true }, job),
  'baseball-live':                async (job) => runBaseballLive(job.data),
  'baseball-finalize':            async (job) => runBaseballFinalize(job.data),
  'baseball-cleanup':             async (job) => runBaseballCleanup(job.data),
  'baseball-calibrate':           async () => runBaseballCalibration(),
  // Reenrich + train ML, CPU + I/O heavy → MARATHON lock.
  'baseball-retrain':             async (job) => runBaseballRetrain(job.data),
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
  'futbol-raw-backfill':     1,
  'futbol-retrain':          1,
  'futbol-watchdog':         1,
  'baseball-fixtures':            1,
  'baseball-analyze':             1,
  'baseball-analyze-all-today':   1,
  'baseball-live':                1,
  'baseball-finalize':            1,
  'baseball-cleanup':             1,
  'baseball-calibrate':           1,
  'baseball-retrain':             1,
};

// Lock / stall tuning per queue.
//
// Defaults de BullMQ (lockDuration=30s, stalledInterval=30s, maxStalledCount=1)
// son agresivos para jobs CPU-bound largos: el motor de futbol (Dixon-Coles +
// stages 3-6) bloquea el event loop por tramos que pueden exceder los 30s
// cuando se analizan muchos partidos en paralelo, el setTimeout que renueva
// el lock no se dispara, y el job termina marcado "stalled more than allowable
// limit" aunque siga progresando.
//
// Para jobs pesados subimos lockDuration a 10 min, chequeo de stall a 60s y
// permitimos 3 stalls antes de fallar definitivo. Para jobs livianos (live,
// odds, cleanup) dejamos algo más holgado que el default pero no exagerado.
type LockOpts = { lockDuration: number; stalledInterval: number; maxStalledCount: number };
const HEAVY: LockOpts = { lockDuration: 600_000, stalledInterval: 60_000, maxStalledCount: 3 };
const LIGHT: LockOpts = { lockDuration: 120_000, stalledInterval: 30_000, maxStalledCount: 2 };
// Job MARATÓN (captura cruda, horas): lock de 30min (se auto-renueva mientras
// el event loop está libre — el job es I/O-bound). attempts:1 en la cola evita
// reintentos; idempotente igualmente.
const MARATHON: LockOpts = { lockDuration: 1_800_000, stalledInterval: 120_000, maxStalledCount: 5 };

const lockOpts: Record<QueueName, LockOpts> = {
  'futbol-fixtures':         LIGHT,
  'futbol-daily':            HEAVY,
  'futbol-analyze-batch':    HEAVY,
  'futbol-analyze-all-today':HEAVY,
  'futbol-finalize':         HEAVY,
  'futbol-cleanup':          LIGHT,
  'futbol-lineups':          HEAVY,
  'futbol-live':             LIGHT,
  'futbol-live-corners':     LIGHT,
  'futbol-odds':             LIGHT,
  'futbol-raw-backfill':     MARATHON,
  // Ciclo capture(API)→reenrich(CPU)→profiles(CPU)→train(CPU pesado). Puede
  // tardar 10-20 min; lock MARATÓN para que no lo marquen stalled.
  'futbol-retrain':          MARATHON,
  'futbol-watchdog':         LIGHT,
  'baseball-fixtures':            LIGHT,
  'baseball-analyze':             HEAVY,
  'baseball-analyze-all-today':   HEAVY,
  'baseball-live':                LIGHT,
  'baseball-finalize':            HEAVY,
  'baseball-cleanup':             LIGHT,
  'baseball-calibrate':           HEAVY,
  // reenrich + train pueden tardar 5-15 min con dataset completo.
  'baseball-retrain':             MARATHON,
};

export type WorkerRole = 'all' | 'realtime' | 'heavy';

// Colas que corren en el proceso "realtime": pollers en vivo de alta frecuencia
// + sus broadcasts WS. Deben ir AISLADAS de los jobs CPU-bound (daily, analyze,
// retrain) que bloquean el event loop. Todo lo que NO esté aquí = "heavy".
// Esta es la línea divisoria de la Fase 1: un retrain de 20 min en 'heavy' ya
// no puede congelar el tick de 20s de 'futbol-live' ni el /health en 'realtime'.
const REALTIME_QUEUES: QueueName[] = ['futbol-live', 'baseball-live'];

function queuesForRole(role: WorkerRole): QueueName[] {
  const all = Object.keys(handlers) as QueueName[];
  if (role === 'realtime') return all.filter((q) => REALTIME_QUEUES.includes(q));
  if (role === 'heavy')    return all.filter((q) => !REALTIME_QUEUES.includes(q));
  return all; // 'all' = monolito (comportamiento previo a la Fase 1)
}

// JS-2b: errores de worker que son blips transitorios de reconexión a Redis
// (ioredis/BullMQ reconectan solos) → NO son caídas; loguear sin alertar.
const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

export function startWorkers(role: WorkerRole = 'all'): Worker[] {
  const workers: Worker[] = [];
  const names = queuesForRole(role);
  for (const name of names) {
    const handler = handlers[name];
    const lo = lockOpts[name];
    const w = new Worker(name, handler, {
      connection: bullConnection,
      concurrency: concurrency[name],
      lockDuration: lo.lockDuration,
      stalledInterval: lo.stalledInterval,
      maxStalledCount: lo.maxStalledCount,
    });
    w.on('completed', (job) => {
      logger.info({ queue: name, jobId: job.id }, 'job completed');
    });
    w.on('failed', (job, err) => {
      // JS-2: BullMQ emite 'failed' en CADA intento, no solo al agotar attempts.
      // Alertar solo en el fallo TERMINAL (reintentos agotados); los intermedios
      // suelen recuperarse en el siguiente intento → solo log, sin alerta.
      const isFinal = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? 1);
      if (isFinal) {
        notifyError(
          { source: 'job', name, jobId: job?.id, extra: { attempts: job?.attemptsMade } },
          err,
        ).catch(() => {});
      } else {
        logger.warn({ queue: name, jobId: job?.id, attempt: job?.attemptsMade }, 'job failed (will retry)');
      }
    });
    w.on('error', (err) => {
      // JS-2b: distinguir blips transitorios de reconexión a Redis (no son
      // caídas; ioredis/BullMQ reconectan solos) de errores reales del worker.
      const code = (err as NodeJS.ErrnoException)?.code;
      const msg = err?.message || '';
      const isTransient =
        (code != null && TRANSIENT_CODES.has(code)) ||
        /connection is closed|redis.*closed/i.test(msg);
      if (isTransient) {
        logger.warn({ queue: name, code, msg: msg.slice(0, 120) }, 'worker transient error (no alert)');
        return;
      }
      notifyError({ source: 'job', name, extra: { kind: 'worker-error' } }, err).catch(() => {});
    });
    workers.push(w);
  }
  logger.info({ count: workers.length, role, queues: names }, 'workers started');
  return workers;
}
