import { analyzeSportDate, bogotaToday, cronTargetDate, triggerEvent } from '../../shared.js';

/** @param {string} sport @param {any} payload @param {any} job */
async function run(sport, payload, job) {
  // `today` fija la jornada en curso: cronTargetDate salta a mañana después del
  // mediodía de Bogotá, justo cuando corren los pases previos al salto inicial.
  const date = payload.date || (payload.today === true ? bogotaToday() : cronTargetDate());
  const startedAt = Date.now();
  await job?.updateProgress?.({ phase: 'starting', sport, date, startedAt });
  // NCAA puede superar 300 partidos en una jornada. Sus cuotas vienen en el
  // calendario y el motor usa PostgreSQL, de modo que seis tareas concurrentes
  // reducen la ventana sin multiplicar llamadas al proveedor.
  // Pases de reintento (NFL): `onlyMissingCurrent`+`retryMissingOdds` sólo
  // vuelven a tocar partidos que YA tienen análisis pero sin cuota todavía —
  // `minLeadMs` (oddsRetryMinLeadMs) evita tocar un partido a menos de esa
  // distancia de su propio kickoff, sin importar a qué hora corrió el cron.
  const result = await analyzeSportDate(sport, date, {
    concurrency: 6,
    oddsTtl: Number(payload.oddsTtl) > 0 ? Number(payload.oddsTtl) : 6 * 3600,
    // Pase previo: solo partidos que empiezan dentro de `pregameWindowMs`, con
    // la cuota recién leída. `competitionKeys` lo limita a la NBA para no
    // reanalizar cada hora los cientos de partidos universitarios.
    pregame: payload.pregame === true,
    pregameWindowMs: payload.pregameWindowMs,
    competitionKeys: Array.isArray(payload.competitionKeys) ? payload.competitionKeys : undefined,
    onlyMissingCurrent: payload.onlyMissingCurrent === true,
    retryMissingOdds: payload.retryMissingOdds === true,
    oddsRetryMinLeadMs: payload.oddsRetryMinLeadMs,
  });
  await job?.updateProgress?.({ phase: result.ok ? 'complete' : 'failed', ...result, startedAt });
  if (!result.ok) throw new Error(`${sport} analyze incompleto: ${result.failed}/${result.total}`);
  await triggerEvent(`${sport}-analysis`, 'ready', { date, analyzed: result.analyzed, at: new Date().toISOString() });
  return result;
}

/** @param {any} payload @param {any} job */
export const runBasketballAnalyze = (payload = {}, job = null) => run('basketball', payload, job);
/** @param {any} payload @param {any} job */
export const runAmericanFootballAnalyze = (payload = {}, job = null) => run('american_football', payload, job);
