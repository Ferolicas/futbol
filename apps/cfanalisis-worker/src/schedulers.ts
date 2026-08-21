import { queues, type QueueName } from './queues.js';
import { logger } from './logger.js';
import { MULTISPORT_CACHE_VERSION, bogotaToday } from './shared.js';

// Schedulers nativos del worker (BullMQ Job Schedulers). Reemplazan a
// cron-job.org: el worker se auto-dispara usando el Redis local del VPS.
//
// Dos zonas horarias en juego — NO confundir:
//  1. Los crons generales disparan en España (Europe/Madrid), DST-aware.
//  2. Baseball fixtures/analyze/pregame dispara directamente en Colombia para
//     que la publicación de cuotas no cambie una hora con el DST europeo.
//  3. El DÍA objetivo se calcula en America/Bogota dentro de cada handler.
//
// Los crons "cada N minutos" son TZ-agnósticos (el tz no aplica).
const TZ = 'Europe/Madrid';
const BOGOTA_TZ = 'America/Bogota';

// `pattern` = cron (granularidad mínima 1 min). `every` = intervalo exacto en
// ms (ej. live cada 30s). Usar uno u otro, no ambos.
type Sched = { queue: QueueName; id: string; pattern?: string; every?: number; tz?: string; data?: Record<string, unknown> };

// IDs de schedulers viejos a eliminar en cada arranque (evita que sigan
// corriendo en paralelo tras cambiar el id/cadencia de un job).
// 'futbol-raw-backfill-half2' fue un seed one-shot (ya completado a mano). Al
// añadirlo aquí, registerSchedulers() llama removeJobScheduler() en el arranque
// → borra el scheduler Y su job delayed pendiente de Redis (no corre a las 4am).
// 'futbol-live-corners-30m': el polling de córners se integró al tick live de
// futbol-live (PARTE 1: /fixtures/statistics dentro de live.js). El job dedicado
// de 30 min queda obsoleto → al añadir su id aquí, registerSchedulers() borra el
// scheduler Y su job delayed pendiente en el arranque (no quedan dos corriendo).
// 'baseball-analysis-coverage-15m': la guardia se mudó a la cola
// 'baseball-coverage'. Su id viejo entra aquí para que BullMQ borre el
// scheduler Y el job delayed pendiente en la cola 'baseball-analyze' y no
// queden las dos versiones disparando en paralelo.
const STALE_SCHEDULER_IDS = ['futbol-live-1m', 'futbol-live-20s', 'futbol-live-90s', 'futbol-odds-15m', 'futbol-raw-backfill-half2', 'baseball-live-5m', 'futbol-live-corners-30m', 'futbol-odds-30m', 'baseball-calibrate-daily', 'baseball-analyze-all-today-daily', 'american-football-live-10m', 'futbol-finalize-daily', 'baseball-analysis-coverage-15m'];

const SCHEDULES: Sched[] = [
  // ── Fútbol — diarios (hora España) ──
  // ORDEN del ciclo de auto-mejora del modelo:
  //   cada 15 min     finalize  → cierra solo partidos cuyo final estimado pasó
  //   06:30          retrain   → captura reciente, ingesta, perfiles y entrenamiento
  //   07:00          model-sync → segunda captura/ingesta y perfiles de respaldo
  //   07:30          watchdog → confirma que el ciclo terminó correctamente
  //   02:05 (día sig) fixtures + 02:10 daily → usa el último modelo activo
  { queue: 'futbol-fixtures',  id: 'futbol-fixtures-daily',  pattern: '5 2 * * *',   tz: TZ },
  { queue: 'futbol-daily',     id: 'futbol-daily-daily',     pattern: '10 2 * * *',  tz: TZ },
  { queue: 'futbol-finalize',  id: 'futbol-finalize-15m',    pattern: '*/15 * * * *' },
  { queue: 'futbol-retrain',   id: 'futbol-retrain-daily',   pattern: '30 6 * * *',  tz: TZ },
  { queue: 'futbol-model-sync', id: 'futbol-model-sync-daily', pattern: '0 7 * * *',  tz: TZ },
  // Dead-man's switch: confirma daily, retrain y model-sync.
  { queue: 'futbol-watchdog',  id: 'futbol-watchdog-daily',  pattern: '30 7 * * *',  tz: TZ },
  { queue: 'futbol-cleanup',   id: 'futbol-cleanup-daily',   pattern: '0 3 * * *',   tz: TZ },
  // ── Fútbol — periódicos ──
  // Live cada 30s: el handler hace smart-skip (0 llamadas fuera de partidos).
  // Marcador/eventos/córners/detalle se refrescan por lotes; el plan Ultra de
  // 75.000 llamadas/día permite recuperar esta cadencia sin retirar cobertura.
  { queue: 'futbol-live',         id: 'futbol-live-30s',         every: 30_000 },
  { queue: 'futbol-lineups',      id: 'futbol-lineups-5m',       pattern: '*/5 * * * *' },
  // futbol-live-corners ELIMINADO — los córners se traen ahora en el tick live
  // de futbol-live (PARTE 1). Su id viejo está en STALE_SCHEDULER_IDS para que
  // BullMQ lo limpie. La cola/worker (queues.ts, workers.ts) quedan inertes (sin
  // job que los dispare); no se borran para minimizar riesgo.
  // Cuotas ricas Bet365/Bwin: vigilancia adaptativa de ayer/hoy/mañana hasta
  // el kickoff. Una respuesta vacía se reintenta siempre (15-60 min según la
  // cercanía) y un catálogo existente se vuelve a consultar con más frecuencia
  // al acercarse el partido para capturar líneas publicadas tarde.
  { queue: 'futbol-odds',        id: 'futbol-api-odds-15m',      pattern: '*/15 * * * *' },
  // ── Baseball — diarios (hora Colombia) ──
  // La madrugada española era demasiado pronto: API-Baseball aún no había
  // publicado la cartelera/cuotas de Bet365 y el análisis quedaba completo
  // estadísticamente, pero sin opciones apostables. El pase principal corre a
  // las 10:30 de Colombia; la cartelera oficial se prepara diez minutos antes.
  { queue: 'baseball-fixtures',  id: 'baseball-fixtures-daily', pattern: '20 10 * * *', tz: BOGOTA_TZ },
  { queue: 'baseball-analyze',   id: 'baseball-analyze-daily', pattern: '30 10 * * *', tz: BOGOTA_TZ, data: { force: true, today: true } },
  // Guardia de cobertura: calendario oficial de ayer/hoy/mañana contra la
  // versión vigente. También considera pendiente un juego MLB futuro del día
  // actual que siga sin cuotas después de las 10:30 de Colombia. Así reintenta
  // cada 15 min solo esos IDs y se detiene en cuanto Bet365 aparece.
  // La guardia vive en SU PROPIA cola desde el incidente del 5 de agosto de
  // 2026: compartiendo cola con el pase diario, un coverage colgado dejó el
  // análisis principal esperando detrás 31 horas.
  { queue: 'baseball-coverage',  id: 'baseball-coverage-15m', pattern: '*/15 * * * *', data: { coverage: true } },
  // Re-análisis PRE-PARTIDO (force + today): captura el lineup confirmado de MLB
  // (props de bateadores) de los juegos que se juegan HOY Colombia. Corre en la
  // franja en que MLB publica alineaciones. Se expresa directamente en hora
  // Colombia para que el horario no cambie cuando España entra/sale de DST.
  // Solo incluye juegos a -1h/+3h del kickoff y conserva el refresco de props.
  { queue: 'baseball-analyze', id: 'baseball-analyze-pregame', pattern: '0 12,14,16,18,20,22 * * *', tz: BOGOTA_TZ, data: { force: true, today: true, pregame: true } },
  // ventana 365d (default del job). MLB Stats API es gratuita y sin límite de
  // fechas, así que rellenamos resultados retroactivos sin penalización.
  // Dos pases: el de 05:00 recoge la mayoría y el de 09:00 cierra los juegos
  // nocturnos de la costa oeste antes del entrenamiento.
  // Hombre muerto del béisbol (equivalente al de fútbol). 12:00 Colombia: hora y
  // media después del pase diario de las 10:30. Silencio = todo bien.
  { queue: 'baseball-watchdog',  id: 'baseball-watchdog-daily', pattern: '0 12 * * *', tz: BOGOTA_TZ },
  { queue: 'baseball-finalize',  id: 'baseball-finalize-daily',  pattern: '0 5,9 * * *',  tz: TZ },
  // La calibración isotónica quedó retirada: el porcentaje servido es la
  // frecuencia empírica. Retrain solo escoge pesos de semejanza walk-forward.
  // 10:40 evita competir exactamente a :30 con la guardia de cobertura.
  { queue: 'baseball-retrain',   id: 'baseball-retrain-daily',   pattern: '40 10 * * *', tz: TZ },
  { queue: 'baseball-cleanup',   id: 'baseball-cleanup-weekly',  pattern: '0 3 * * 0',  tz: TZ }, // dom 3:00
  // ── Baseball — live (cada 1 min) ──
  // MLB Stats API es gratuita y sin límite, así que polleamos cada minuto.
  // El handler emite el WS update y, si hay juegos en
  // vivo, pide el feed pitch-by-pitch (concurrency 6) para detectar carreras,
  // home runs, K dorado y cambio de inning. Sin juegos en vivo: dos llamadas
  // de schedule (hoy + ayer Colombia) y persiste cualquier FT pendiente. El día
  // anterior evita perder juegos de costa oeste al cruzar medianoche local.
  { queue: 'baseball-live', id: 'baseball-live-1m', every: 60_000 },

  // ── Baloncesto NBA + NCAA ───────────────────────────────────────────
  // NBA oficial es primaria y NCAA usa calendario/boxscore deportivo público.
  // API-Basketball queda para cuotas y último fallback de NBA.
  { queue: 'basketball-fixtures', id: 'basketball-fixtures-daily', pattern: '10 1 * * *', tz: TZ },
  { queue: 'basketball-analyze', id: 'basketball-analyze-daily', pattern: '40 1 * * *', tz: TZ },
  { queue: 'basketball-finalize', id: 'basketball-finalize-daily', pattern: '0 8,11 * * *', tz: TZ },
  { queue: 'basketball-retrain', id: 'basketball-retrain-daily', pattern: '30 12 * * *', tz: TZ },
  // Smart-window evita trabajo fuera de juegos; los calendarios universitarios
  // no consumen el presupuesto de API-Basketball.
  { queue: 'basketball-live', id: 'basketball-live-10m', every: 600_000 },

  // ── Fútbol americano NFL + NCAA FBS/FCS ────────────────────────────
  { queue: 'american-football-fixtures', id: 'american-football-fixtures-daily', pattern: '15 1 * * *', tz: TZ },
  { queue: 'american-football-analyze', id: 'american-football-analyze-daily', pattern: '50 1 * * *', tz: TZ },
  { queue: 'american-football-finalize', id: 'american-football-finalize-daily', pattern: '15 8,11 * * *', tz: TZ },
  { queue: 'american-football-retrain', id: 'american-football-retrain-daily', pattern: '0 13 * * *', tz: TZ },
  // NFL conserva el respaldo existente; FBS/FCS usa su fuente pública y el
  // mismo smart-window. El intervalo evita trabajo continuo fuera de partidos.
  { queue: 'american-football-live', id: 'american-football-live-30m', every: 1_800_000 },
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

// Se invoca desde el proceso heavy después de crear sus Workers. El jobId por
// contrato+día hace el arranque idempotente y garantiza que un deploy que suba
// CACHE_VERSION regenere la jornada sin esperar al siguiente cron nocturno.
export async function enqueueBaseballCoverageBootstrap(): Promise<void> {
  const date = bogotaToday();
  const jobId = `baseball-coverage-v${MULTISPORT_CACHE_VERSION}-odds-refresh-v2-bogota-${date}`;
  const job = await queues['baseball-coverage'].add(
    'baseball-coverage',
    { coverage: true, bootstrap: true },
    { jobId },
  );
  logger.info({ queue: 'baseball-coverage', jobId: job.id, date, cacheVersion: MULTISPORT_CACHE_VERSION }, 'baseball coverage bootstrap listo');
}
