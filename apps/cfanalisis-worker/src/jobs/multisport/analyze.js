// @ts-nocheck
import { analyzeSportDate, cronTargetDate } from '../../shared.js';

/** @param {string} sport @param {any} payload @param {any} job */
async function run(sport, payload, job) {
  const date = payload.date || cronTargetDate();
  const startedAt = Date.now();
  await job?.updateProgress?.({ phase: 'starting', sport, date, startedAt });
  // NCAA puede superar 300 partidos en una jornada. Sus cuotas vienen en el
  // calendario y el motor usa PostgreSQL, de modo que seis tareas concurrentes
  // reducen la ventana sin multiplicar llamadas al proveedor.
  const result = await analyzeSportDate(sport, date, { concurrency: 6, oddsTtl: 6 * 3600 });
  await job?.updateProgress?.({ phase: result.ok ? 'complete' : 'failed', ...result, startedAt });
  if (!result.ok) throw new Error(`${sport} analyze incompleto: ${result.failed}/${result.total}`);
  return result;
}

/** @param {any} payload @param {any} job */
export const runBasketballAnalyze = (payload = {}, job = null) => run('basketball', payload, job);
/** @param {any} payload @param {any} job */
export const runAmericanFootballAnalyze = (payload = {}, job = null) => run('american_football', payload, job);
