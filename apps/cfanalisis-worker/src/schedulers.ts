import { queues, type QueueName } from './queues.js';
import { logger } from './logger.js';

// Schedulers nativos del worker (BullMQ Job Schedulers). Reemplazan a
// cron-job.org: el worker se auto-dispara usando el Redis local del VPS.
//
// Dos zonas horarias en juego — NO confundir:
//  1. Cuándo DISPARA el cron → hora de España (Europe/Madrid). DST-aware.
//  2. Qué DÍA analiza cada job → hora Colombia (America/Bogota), calculado
//     dentro del propio handler (futbol-daily, baseball-analyze). Es
//     independiente de cuándo dispara.
//
// Los crons "cada N minutos" son TZ-agnósticos (el tz no aplica).
const TZ = 'Europe/Madrid';

// `pattern` = cron (granularidad mínima 1 min). `every` = intervalo en ms
// (para sub-minuto, ej. live cada 20s). Usar uno u otro, no ambos.
type Sched = { queue: QueueName; id: string; pattern?: string; every?: number; tz?: string };

// IDs de schedulers viejos a eliminar en cada arranque (evita que sigan
// corriendo en paralelo tras cambiar el id/cadencia de un job).
const STALE_SCHEDULER_IDS = ['futbol-live-1m'];

const SCHEDULES: Sched[] = [
  // ── Fútbol — diarios (hora España) ──
  { queue: 'futbol-fixtures', id: 'futbol-fixtures-daily', pattern: '5 2 * * *',   tz: TZ },
  { queue: 'futbol-daily',    id: 'futbol-daily-daily',    pattern: '10 2 * * *',  tz: TZ },
  { queue: 'futbol-finalize', id: 'futbol-finalize-daily', pattern: '0 3,4 * * *', tz: TZ },
  { queue: 'futbol-cleanup',  id: 'futbol-cleanup-daily',  pattern: '0 3 * * *',   tz: TZ },
  // ── Fútbol — periódicos ──
  // Live cada 20s: el handler hace smart-skip (0 llamadas fuera de partidos),
  // así que el 3x del intervalo solo aplica durante ventanas en vivo. En plan
  // Ultra (75k/día) eso son ~2.5k/día (~3,5% de cuota). Objetivo: ver el gol
  // a los ~20s.
  { queue: 'futbol-live',         id: 'futbol-live-20s',         every: 20_000 },
  { queue: 'futbol-lineups',      id: 'futbol-lineups-5m',       pattern: '*/5 * * * *' },
  { queue: 'futbol-live-corners', id: 'futbol-live-corners-30m', pattern: '*/30 * * * *' },
  { queue: 'futbol-odds',         id: 'futbol-odds-15m',         pattern: '*/15 * * * *' },
  // ── Baseball — diarios (hora España) ──
  { queue: 'baseball-fixtures', id: 'baseball-fixtures-daily', pattern: '5 1 * * *',  tz: TZ }, // 1:05
  { queue: 'baseball-analyze',  id: 'baseball-analyze-daily',  pattern: '30 1 * * *', tz: TZ }, // 1:30
  { queue: 'baseball-finalize', id: 'baseball-finalize-daily', pattern: '0 5 * * *',  tz: TZ }, // 5:00
  { queue: 'baseball-cleanup',  id: 'baseball-cleanup-weekly', pattern: '0 3 * * 0',  tz: TZ }, // dom 3:00
  // ── Baseball — live (cada 5 min) ──
  // El handler hace smart-skip: solo gasta API dentro de la ventana de juego,
  // con presupuesto de 30 llamadas/día y throttle dinámico 4-30 min. Fuera de
  // partidos en vivo no consume nada.
  { queue: 'baseball-live', id: 'baseball-live-5m', pattern: '*/5 * * * *' },
];

export async function registerSchedulers(): Promise<void> {
  // Limpiar schedulers viejos (ej. el futbol-live-1m anterior) para que no
  // sigan disparando en paralelo con el nuevo. removeJobScheduler es no-op si
  // el id no existe.
  for (const staleId of STALE_SCHEDULER_IDS) {
    for (const qName of Object.keys(queues) as QueueName[]) {
      try { await queues[qName].removeJobScheduler(staleId); } catch {}
    }
  }

  for (const s of SCHEDULES) {
    const q = queues[s.queue];
    if (!q) {
      logger.warn({ queue: s.queue }, 'scheduler: cola inexistente, skip');
      continue;
    }
    // upsertJobScheduler es idempotente — re-registrar en cada arranque
    // actualiza en sitio, no duplica. `every` (ms) para sub-minuto, `pattern`
    // (cron) para el resto.
    const repeat = s.every != null
      ? { every: s.every }
      : { pattern: s.pattern!, ...(s.tz ? { tz: s.tz } : {}) };
    await q.upsertJobScheduler(s.id, repeat, { name: s.queue, data: {} });
  }
  logger.info({ count: SCHEDULES.length }, 'job schedulers registrados');
}
