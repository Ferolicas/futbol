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
type Sched = { queue: QueueName; id: string; pattern?: string; every?: number; tz?: string; data?: Record<string, unknown> };

// IDs de schedulers viejos a eliminar en cada arranque (evita que sigan
// corriendo en paralelo tras cambiar el id/cadencia de un job).
// 'futbol-raw-backfill-half2' fue un seed one-shot (ya completado a mano). Al
// añadirlo aquí, registerSchedulers() llama removeJobScheduler() en el arranque
// → borra el scheduler Y su job delayed pendiente de Redis (no corre a las 4am).
const STALE_SCHEDULER_IDS = ['futbol-live-1m', 'futbol-odds-15m', 'futbol-raw-backfill-half2'];

const SCHEDULES: Sched[] = [
  // ── Fútbol — diarios (hora España) ──
  // ORDEN del ciclo de auto-mejora del modelo:
  //   03:00 + 04:00  finalize  → cierra resultados de los partidos de la noche
  //   05:00          calibrate → recalcula los knots isotónicos con esos
  //                              resultados frescos (escribe app_config)
  //   06:30          retrain   → ciclo del meta-modelo CONTEXTUAL: captura los
  //                              crudos de los partidos recién finalizados →
  //                              reenrich features_full → reconstruye el ADN →
  //                              re-entrena y re-activa los mercados que superan
  //                              baseline. Va al final (tras finalize+calibrate)
  //                              y en franja de baja actividad live (23:30
  //                              Bogotá) para no starvear los polls al entrenar.
  //   02:05 (día sig) fixtures + 02:10 daily → el análisis del día ya usa la
  //                              calibración y los modelos generados la madrugada
  //                              anterior.
  // Así el modelo se auto-corrige Y aprende cada noche sin intervención manual.
  { queue: 'futbol-fixtures',  id: 'futbol-fixtures-daily',  pattern: '5 2 * * *',   tz: TZ },
  { queue: 'futbol-daily',     id: 'futbol-daily-daily',     pattern: '10 2 * * *',  tz: TZ },
  { queue: 'futbol-finalize',  id: 'futbol-finalize-daily',  pattern: '0 3,4 * * *', tz: TZ },
  { queue: 'futbol-retrain',   id: 'futbol-retrain-daily',   pattern: '30 6 * * *',  tz: TZ },
  { queue: 'futbol-cleanup',   id: 'futbol-cleanup-daily',   pattern: '0 3 * * *',   tz: TZ },
  // ── Fútbol — periódicos ──
  // Live cada 20s: el handler hace smart-skip (0 llamadas fuera de partidos),
  // así que el 3x del intervalo solo aplica durante ventanas en vivo. En plan
  // Ultra (75k/día) eso son ~2.5k/día (~3,5% de cuota). Objetivo: ver el gol
  // a los ~20s.
  { queue: 'futbol-live',         id: 'futbol-live-20s',         every: 20_000 },
  { queue: 'futbol-lineups',      id: 'futbol-lineups-5m',       pattern: '*/5 * * * *' },
  { queue: 'futbol-live-corners', id: 'futbol-live-corners-30m', pattern: '*/30 * * * *' },
  // Odds: el cron dispara cada 30min pero el handler tiene PRESUPUESTO de 7
  // llamadas/día con espaciado (primera 2h antes del 1er partido). The Odds API
  // free son 500/mes — el cada-15min anterior las quemaba en 1-2 días.
  { queue: 'futbol-odds',         id: 'futbol-odds-30m',         pattern: '*/30 * * * *' },
  // ── Baseball — diarios (hora España) ──
  { queue: 'baseball-fixtures',  id: 'baseball-fixtures-daily',  pattern: '5 1 * * *',  tz: TZ }, // 1:05
  { queue: 'baseball-analyze',   id: 'baseball-analyze-daily',   pattern: '30 1 * * *', tz: TZ }, // 1:30 — jornada Colombia que arranca
  // Re-análisis PRE-PARTIDO (force + today): captura el lineup confirmado de MLB
  // (props de bateadores) de los juegos que se juegan HOY Colombia. Corre en la
  // franja en que MLB publica alineaciones (tarde Colombia = 17-01 España). Odds
  // cacheadas (3h) → no quema The Odds API; game logs cacheados (6h).
  { queue: 'baseball-analyze',   id: 'baseball-analyze-pregame', pattern: '0 17,19,21,23,1 * * *', tz: TZ, data: { force: true, today: true } },
  // days:3 — el plan GRATUITO de api-baseball solo permite consultar los
  // últimos 3 días. La ventana de finalize se limita a eso para no pedir
  // fechas que la API rechazaría igualmente.
  { queue: 'baseball-finalize',  id: 'baseball-finalize-daily',  pattern: '0 5 * * *',  tz: TZ }, // 5:00 — ventana 365d (default del job); MLB Stats API sin límite de fechas
  { queue: 'baseball-calibrate', id: 'baseball-calibrate-daily', pattern: '0 6 * * *',  tz: TZ }, // 6:00 (tras finalize)
  { queue: 'baseball-cleanup',   id: 'baseball-cleanup-weekly',  pattern: '0 3 * * 0',  tz: TZ }, // dom 3:00
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
    await q.upsertJobScheduler(s.id, repeat, { name: s.queue, data: s.data ?? {} });
  }
  logger.info({ count: SCHEDULES.length }, 'job schedulers registrados');
}
