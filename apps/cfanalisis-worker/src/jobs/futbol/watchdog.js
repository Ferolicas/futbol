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

  // ── Check 1: futbol-daily completó — robusto a la frontera de cronTargetDate ──
  // cronTargetDate() cambia de resultado según el lado del mediodía-Bogotá y el
  // watchdog corre cerca de esa frontera, así que daily pudo escribir cualquiera
  // de los dos días candidatos. OK si CUALQUIERA tiene el flag completed.
  const d1 = date;            // cronTargetDate()
  const d2 = bogotaToday();
  const days = d1 === d2 ? [d1] : [d1, d2];
  let dailyOk = false;
  let checkedDate = d1;
  for (const d of days) {
    const flag = await redisGet(`dailyBatch:${d}`);
    if (flag?.completed === true) { dailyOk = true; checkedDate = d; break; }
  }
  if (!dailyOk) {
    await notifyError(
      { source: 'job', name: 'futbol-watchdog', extra: { check: 'daily', days } },
      new Error(`Pipeline: futbol-daily NO completó para ${days.join(' / ')}. Re-disparar:\n${retryCmd('futbol-daily')}`),
    ).catch(() => {});
  }

  // ── Check 2: futbol-retrain dejó rastro reciente (<6h) ──
  // Comparar el DÍA (completedAt UTC vs bogotaToday) daba falso positivo
  // nocturno por el desfase de zona. Usamos la EDAD del rastro: el watchdog corre
  // ~1h después de retrain, así que <6h = OK; cualquier cosa más vieja = no corrió.
  const retrain = await redisGet('lastRun:futbol-retrain');
  const retrainMs = retrain?.completedAt ? Date.parse(retrain.completedAt) : NaN;
  const ageHours = Number.isFinite(retrainMs) ? (Date.now() - retrainMs) / 3_600_000 : Infinity;
  const retrainOk = ageHours <= 6;
  if (!retrainOk) {
    await notifyError(
      { source: 'job', name: 'futbol-watchdog', extra: { check: 'retrain', lastRun: retrain?.completedAt || null } },
      new Error(`Pipeline: futbol-retrain NO completó recientemente (último: ${retrain?.completedAt || 'nunca'}). Re-disparar:\n${retryCmd('futbol-retrain')}`),
    ).catch(() => {});
  }

  logger.info({ date, checkedDate, dailyOk, retrainOk, retrainAgeHours: Number.isFinite(ageHours) ? Math.round(ageHours * 10) / 10 : null }, '[futbol-watchdog] checks');
  return { date, dailyOk, retrainOk };
}
