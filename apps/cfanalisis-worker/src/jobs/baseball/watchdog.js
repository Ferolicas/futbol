// @ts-nocheck
/**
 * Job: baseball-watchdog — hombre muerto del pipeline de béisbol.
 *
 * El 5 de agosto de 2026 un pase de coverage se quedó esperando una promesa que
 * nunca resolvió. Siguió renovando su lock, así que BullMQ no lo declaró
 * stalled, y con concurrency=1 bloqueó la cola entera: 31 horas sin analizar un
 * solo partido y sin una sola alerta. El fútbol tenía su watchdog desde hacía
 * meses; el béisbol no.
 *
 * Corre a las 12:00 de Colombia, hora y media después del pase diario de las
 * 10:30, y comprueba tres cosas:
 *   1. baseball-analyze completó hoy       (rastro `lastRun:baseball-daily`)
 *   2. la guardia de cobertura sigue viva  (rastro `lastRun:baseball-coverage`)
 *   3. la jornada de hoy está analizada    (filas en baseball_match_analysis)
 *
 * Silencio = todo bien.
 */
import { redisGet, bogotaToday, pgPool } from '../../shared.js';
import { notifyError } from '../../notifier.js';
import { logger } from '../../logger.js';

const MAX_AGE_HOURS = { daily: 6, coverage: 1.5 };

function ageHours(trace) {
  const ms = trace?.completedAt ? Date.parse(trace.completedAt) : NaN;
  return Number.isFinite(ms) ? (Date.now() - ms) / 3_600_000 : Infinity;
}

const retryCmd = (queue, payload = '{}') =>
  `curl -X POST http://127.0.0.1:8080/admin/retry -H "Authorization: Bearer WORKER_SECRET"`
  + ` -H "Content-Type: application/json" -d '{"queue":"${queue}","data":${payload}}'`;

export async function runBaseballWatchdog() {
  const date = bogotaToday();
  const alerts = [];

  const daily = await redisGet('lastRun:baseball-daily');
  const dailyAge = ageHours(daily);
  const dailyOk = dailyAge <= MAX_AGE_HOURS.daily;
  if (!dailyOk) {
    alerts.push(
      `Béisbol: el pase diario no completó (último: ${daily?.completedAt || 'nunca'}).`
      + ` Re-disparar:\n${retryCmd('baseball-analyze', '{"force":true,"today":true}')}`,
    );
  }

  // La guardia corre cada 15 min: más de hora y media de silencio significa que
  // la cola está atascada, que es exactamente el fallo que nadie vio en agosto.
  const coverage = await redisGet('lastRun:baseball-coverage');
  const coverageAge = ageHours(coverage);
  const coverageOk = coverageAge <= MAX_AGE_HOURS.coverage;
  if (!coverageOk) {
    alerts.push(
      `Béisbol: la guardia de cobertura lleva ${Number.isFinite(coverageAge) ? `${coverageAge.toFixed(1)} h` : 'siempre'}`
      + ` sin completar — la cola baseball-coverage puede estar bloqueada por un job colgado.`
      + ` Revisar 'active' y reiniciar cfanalisis-heavy si procede.`,
    );
  }

  // Comprobación de resultado, no solo de proceso: que los jobs digan "ok" no
  // sirve de nada si la tabla del día sigue vacía.
  let analyzed = 0;
  try {
    const { rows } = await pgPool.query(
      `SELECT count(*)::int AS n FROM baseball_match_analysis
       WHERE date = $1 AND updated_at > now() - interval '18 hours'`,
      [date],
    );
    analyzed = rows[0]?.n || 0;
  } catch (error) {
    alerts.push(`Béisbol: no se pudo verificar la jornada en base de datos (${error.message}).`);
  }
  const slateOk = analyzed > 0;
  if (!slateOk) {
    alerts.push(
      `Béisbol: la jornada ${date} no tiene ningún análisis fresco en baseball_match_analysis.`
      + ` Re-disparar:\n${retryCmd('baseball-analyze', '{"force":true,"today":true}')}`,
    );
  }

  for (const message of alerts) {
    await notifyError(
      { source: 'job', name: 'baseball-watchdog', extra: { date, dailyAge, coverageAge, analyzed } },
      new Error(message),
    ).catch(() => {});
  }

  logger.info({
    date, dailyOk, coverageOk, slateOk, analyzed,
    dailyAgeHours: Number.isFinite(dailyAge) ? Math.round(dailyAge * 10) / 10 : null,
    coverageAgeHours: Number.isFinite(coverageAge) ? Math.round(coverageAge * 10) / 10 : null,
  }, '[baseball-watchdog] checks');

  return { date, dailyOk, coverageOk, slateOk, analyzed, alerts: alerts.length };
}
