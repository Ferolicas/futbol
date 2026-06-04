// @ts-nocheck
/**
 * Job: futbol-watchdog — dead-man's switch del pipeline nocturno (JS-1).
 *
 * Corre a las 07:30 Madrid (después de futbol-retrain 06:30) y verifica que los
 * dos jobs críticos COMPLETARON en su ventana:
 *   1. futbol-daily   → flag Redis `dailyBatch:{date}` con .completed === true
 *   2. futbol-retrain → flag Redis `lastRun:futbol-retrain` con completedAt de hoy
 *
 * Si alguno NO completó, avisa a Telegram con el comando exacto para
 * re-dispararlo. Silencio = todo bien (no alerta si ambos están OK).
 *
 * Idempotente y read-only: solo lee flags y, si procede, notifica.
 */
import { redisGet, cronTargetDate, bogotaToday } from '../../shared.js';
import { notifyError } from '../../notifier.js';
import { logger } from '../../logger.js';

export async function runWatchdog(data = {}) {
  // Mismo día canónico (Bogotá) que usa daily para escribir dailyBatch:{date}.
  const date = cronTargetDate();

  // Comando de re-disparo reutilizable. Va directo al worker en localhost:8080
  // (el operador sustituye WORKER_SECRET por el valor real del .env).
  const retryCmd = (queue) =>
    `curl -X POST http://127.0.0.1:8080/admin/retry -H "Authorization: Bearer WORKER_SECRET" -H "Content-Type: application/json" -d '{"queue":"${queue}"}'`;

  // ── Check 1: futbol-daily completó para el día canónico ──
  const daily = await redisGet(`dailyBatch:${date}`);
  const dailyOk = daily?.completed === true;
  if (!dailyOk) {
    await notifyError(
      { source: 'job', name: 'futbol-watchdog', extra: { check: 'daily', date } },
      new Error(`Pipeline: futbol-daily NO completó para ${date}. Re-disparar:\n${retryCmd('futbol-daily')}`),
    ).catch(() => {});
  }

  // ── Check 2: futbol-retrain dejó rastro de HOY (Bogotá) ──
  // completedAt es ISO UTC; a las 07:30 Madrid (madrugada UTC) la fecha UTC y la
  // de Bogotá coinciden, así que comparar la parte YYYY-MM-DD contra bogotaToday()
  // es simple y robusto.
  const retrain = await redisGet('lastRun:futbol-retrain');
  const retrainDay = typeof retrain?.completedAt === 'string' ? retrain.completedAt.slice(0, 10) : null;
  const retrainOk = retrainDay != null && retrainDay === bogotaToday();
  if (!retrainOk) {
    await notifyError(
      { source: 'job', name: 'futbol-watchdog', extra: { check: 'retrain', lastRun: retrainDay } },
      new Error(`Pipeline: futbol-retrain NO completó hoy (último: ${retrainDay || 'nunca'}). Re-disparar:\n${retryCmd('futbol-retrain')}`),
    ).catch(() => {});
  }

  logger.info({ date, dailyOk, retrainOk }, '[futbol-watchdog] checks');
  return { date, dailyOk, retrainOk };
}
