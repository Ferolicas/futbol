import { queues, type QueueName } from './queues.js';
import { logger } from './logger.js';
import { MULTISPORT_CACHE_VERSION, bogotaToday } from './shared.js';

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
// 'futbol-live-corners-30m': el polling de córners se integró al tick de 20s de
// futbol-live (PARTE 1: /fixtures/statistics dentro de live.js). El job dedicado
// de 30 min queda obsoleto → al añadir su id aquí, registerSchedulers() borra el
// scheduler Y su job delayed pendiente en el arranque (no quedan dos corriendo).
const STALE_SCHEDULER_IDS = ['futbol-live-1m', 'futbol-odds-15m', 'futbol-raw-backfill-half2', 'baseball-live-5m', 'futbol-live-corners-30m', 'futbol-odds-30m', 'baseball-calibrate-daily', 'baseball-analyze-all-today-daily', 'american-football-live-10m', 'futbol-finalize-daily'];

const SCHEDULES: Sched[] = [
  // ── Fútbol — diarios (hora España) ──
  // ORDEN del ciclo de auto-mejora del modelo:
  //   cada 15 min     finalize  → cierra solo partidos cuyo final estimado pasó
  //   06:30          retrain   → ciclo del motor EMPÍRICO CONTEXTUAL: captura los
  //                              crudos de los partidos recién finalizados →
  //                              ingiere hechos → reconstruye perfiles → entrena
  //                              pesos point-in-time y valida cada mercado/línea
  //                              fuera de muestra. Va tras finalize
  //                              y en franja de baja actividad live (23:30
  //                              Bogotá) para no starvear los polls al entrenar.
  //   07:00          model-sync → segunda captura/ingesta y perfiles de respaldo.
  //   07:30          watchdog → confirma que el ciclo terminó correctamente.
  //   02:05 (día sig) fixtures + 02:10 daily → usa el último modelo activo.
  // Así el modelo se auto-corrige Y aprende cada noche sin intervención manual.
  { queue: 'futbol-fixtures',  id: 'futbol-fixtures-daily',  pattern: '5 2 * * *',   tz: TZ },
  { queue: 'futbol-daily',     id: 'futbol-daily-daily',     pattern: '10 2 * * *',  tz: TZ },
  { queue: 'futbol-finalize',  id: 'futbol-finalize-15m',    pattern: '*/15 * * * *' },
  { queue: 'futbol-retrain',   id: 'futbol-retrain-daily',   pattern: '30 6 * * *',  tz: TZ },
  // Sync nocturno del schema `model` (07:00 Madrid, tras retrain 06:30 y antes
  // del watchdog 07:30). Captura players+standings e ingiere hechos nuevos.
  { queue: 'futbol-model-sync', id: 'futbol-model-sync-daily', pattern: '0 7 * * *',  tz: TZ },
  // Dead-man's switch (JS-1): a las 07:30 Madrid (tras retrain 06:30) verifica
  // que daily y retrain completaron; si no, alerta a Telegram con el comando de
  // re-disparo. Silencio = todo OK.
  { queue: 'futbol-watchdog',  id: 'futbol-watchdog-daily',  pattern: '30 7 * * *',  tz: TZ },
  { queue: 'futbol-cleanup',   id: 'futbol-cleanup-daily',   pattern: '0 3 * * *',   tz: TZ },
  // ── Fútbol — periódicos ──
  // Live cada 20s: el handler hace smart-skip (0 llamadas fuera de partidos),
  // así que el 3x del intervalo solo aplica durante ventanas en vivo. En plan
  // Mega (150k/día) eso son ~2.5k/día (~1,7% de cuota). Objetivo: ver el gol
  // a los ~20s.
  { queue: 'futbol-live',         id: 'futbol-live-20s',         every: 20_000 },
  { queue: 'futbol-lineups',      id: 'futbol-lineups-5m',       pattern: '*/5 * * * *' },
  // futbol-live-corners ELIMINADO — los córners se traen ahora en el tick de 20s
  // de futbol-live (PARTE 1). Su id viejo está en STALE_SCHEDULER_IDS para que
  // BullMQ lo limpie. La cola/worker (queues.ts, workers.ts) quedan inertes (sin
  // job que los dispare); no se borran para minimizar riesgo.
  // Odds de FÚTBOL: ELIMINADO. The Odds API se quitó del fútbol — API-Football ya
  // trae bet365/bwin (superset). Su id 'futbol-odds-30m' está en STALE_SCHEDULER_IDS
  // para que BullMQ borre el scheduler + su job delayed en el arranque. La cola/
  // worker quedan inertes (sin job que los dispare). Baseball sigue usando odds.
  // ── Baseball — diarios (hora España) ──
  { queue: 'baseball-fixtures',  id: 'baseball-fixtures-daily',  pattern: '5 1 * * *',  tz: TZ }, // 1:05
  { queue: 'baseball-analyze',   id: 'baseball-analyze-daily',   pattern: '30 1 * * *', tz: TZ }, // 1:30 — jornada Colombia que arranca
  // Guardia de cobertura: calendario oficial de ayer/hoy/mañana contra la
  // versión vigente. Solo procesa IDs ausentes u obsoletos, por lo que una
  // jornada de 400 partidos ya sana cuesta únicamente tres lecturas de
  // calendario y cero reanálisis. También recoge juegos añadidos tarde.
  { queue: 'baseball-analyze',   id: 'baseball-analysis-coverage-15m', pattern: '*/15 * * * *', data: { coverage: true } },
  // Re-análisis PRE-PARTIDO (force + today): captura el lineup confirmado de MLB
  // (props de bateadores) de los juegos que se juegan HOY Colombia. Corre en la
  // franja en que MLB publica alineaciones (tarde Colombia = 17-01 España). Odds
  // Se filtran solo juegos a -1h/+3h del kickoff; cuotas API-Baseball cacheadas
  // 6h y game logs MLB cacheados. Así cada juego se refresca cerca de empezar
  // sin agotar el plan gratuito de 100 llamadas.
  { queue: 'baseball-analyze',   id: 'baseball-analyze-pregame', pattern: '0 17,19,21,23,1 * * *', tz: TZ, data: { force: true, today: true, pregame: true } },
  // ventana 365d (default del job). MLB Stats API es gratuita y sin límite de
  // fechas, así que rellenamos resultados retroactivos sin penalización.
  // Dos pases: el de 05:00 recoge la mayoría y el de 09:00 cierra los juegos
  // nocturnos de la costa oeste antes del entrenamiento.
  { queue: 'baseball-finalize',  id: 'baseball-finalize-daily',  pattern: '0 5,9 * * *',  tz: TZ },
  // La calibración isotónica quedó retirada: el porcentaje servido es la
  // frecuencia empírica. Retrain solo escoge pesos de semejanza walk-forward.
  { queue: 'baseball-retrain',   id: 'baseball-retrain-daily',   pattern: '30 10 * * *', tz: TZ },
  { queue: 'baseball-cleanup',   id: 'baseball-cleanup-weekly',  pattern: '0 3 * * 0',  tz: TZ }, // dom 3:00
  // ── Baseball — live (cada 1 min) ──
  // MLB Stats API es gratuita y sin límite, así que polleamos al mismo ritmo
  // que la app de fútbol. El handler emite el WS update y, si hay juegos en
  // vivo, pide el feed pitch-by-pitch (concurrency 6) para detectar carreras,
  // home runs, K dorado y cambio de inning. Sin juegos en vivo: 1 schedule
  // call y exit (~unas decenas de ms).
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
  const jobId = `baseball-coverage-v${MULTISPORT_CACHE_VERSION}-${date}`;
  const job = await queues['baseball-analyze'].add(
    'baseball-analysis-coverage',
    { coverage: true, bootstrap: true },
    { jobId },
  );
  logger.info({ queue: 'baseball-analyze', jobId: job.id, date, cacheVersion: MULTISPORT_CACHE_VERSION }, 'baseball coverage bootstrap listo');
}
