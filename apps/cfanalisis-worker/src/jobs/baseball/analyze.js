// @ts-nocheck
/**
 * Baseball diario — motor empírico.
 * Datos/identidad/fotos: MLB Stats oficial. Cuotas: API-Baseball.
 * No carga Poisson, isotónica, meta-modelos ni The Odds API.
 */
import { analyzeSportDate, bogotaToday, cronTargetDate } from '../../shared.js';

/** @param {any} payload @param {any} job */
export async function runBaseballAnalyze(payload = {}, job = null) {
  const date = payload.date || (payload.today ? bogotaToday() : cronTargetDate());
  const startedAt = Date.now();
  await job?.updateProgress?.({ phase: 'starting', sport: 'baseball', date, startedAt });
  const result = await analyzeSportDate('baseball', date, {
    force: payload.force === true,
    pregame: payload.pregame === true,
    concurrency: 2,
    oddsTtl: 6 * 3600,
  });
  await job?.updateProgress?.({ phase: result.ok ? 'complete' : 'failed', ...result, startedAt });
  if (!result.ok) throw new Error(`baseball empirical analyze incompleto: ${result.failed}/${result.total}`);
  return { ...result, durationSec: Math.round((Date.now() - startedAt) / 100) / 10 };
}
