// @ts-nocheck
/**
 * Baseball diario — motor empírico.
 * Datos/identidad/fotos: MLB Stats oficial. Cuotas: API-Baseball.
 * No carga Poisson, isotónica, meta-modelos ni The Odds API.
 */
import {
  analyzeSportDate,
  bogotaToday,
  buildSportAnalysisCoverageDates,
  cronTargetDate,
} from '../../shared.js';

function validDates(values) {
  return [...new Set((values || [])
    .map((value) => String(value || ''))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)))];
}

async function runCoverage(payload, job) {
  const dates = validDates(payload.dates);
  const targetDates = dates.length ? dates : buildSportAnalysisCoverageDates(bogotaToday());
  const startedAt = Date.now();
  const reports = [];

  for (const [index, date] of targetDates.entries()) {
    await job?.updateProgress?.({
      phase: 'coverage', sport: 'baseball', date, index: index + 1,
      dates: targetDates.length, startedAt,
    });
    try {
      reports.push(await analyzeSportDate('baseball', date, {
        onlyMissingCurrent: true,
        retryMissingOdds: true,
        concurrency: 2,
        // Bet365 publica líneas durante la mañana de Colombia. Un snapshot
        // vacío no puede vivir seis horas: la guardia vuelve a comprobarlo en
        // su siguiente tick y deja de hacerlo en cuanto aparecen cuotas.
        oddsTtl: 10 * 60,
        oddsMappingTtl: 10 * 60,
      }));
    } catch (error) {
      reports.push({
        ok: false, sport: 'baseball', date, scheduled: 0, total: 0,
        analyzed: 0, alreadyCurrent: 0, failed: 1,
        errors: [error?.message || String(error)],
      });
    }
  }

  const result = {
    ok: reports.every((report) => report.ok),
    sport: 'baseball', mode: 'coverage', dates: targetDates,
    scheduled: reports.reduce((sum, report) => sum + Number(report.scheduled || 0), 0),
    total: reports.reduce((sum, report) => sum + Number(report.total || 0), 0),
    analyzed: reports.reduce((sum, report) => sum + Number(report.analyzed || 0), 0),
    alreadyCurrent: reports.reduce((sum, report) => sum + Number(report.alreadyCurrent || 0), 0),
    failed: reports.reduce((sum, report) => sum + Number(report.failed || 0), 0),
    reports,
    durationSec: Math.round((Date.now() - startedAt) / 100) / 10,
  };
  await job?.updateProgress?.({ phase: result.ok ? 'complete' : 'failed', ...result, startedAt });
  if (!result.ok) throw new Error(`baseball coverage incompleta: ${result.failed} fallos en ${targetDates.join(',')}`);
  return result;
}

/** @param {any} payload @param {any} job */
export async function runBaseballAnalyze(payload = {}, job = null) {
  if (payload.coverage === true) return runCoverage(payload, job);
  const date = payload.date || (payload.today ? bogotaToday() : cronTargetDate());
  const startedAt = Date.now();
  await job?.updateProgress?.({ phase: 'starting', sport: 'baseball', date, startedAt });
  const result = await analyzeSportDate('baseball', date, {
    force: payload.force === true,
    pregame: payload.pregame === true,
    concurrency: 2,
    oddsTtl: 10 * 60,
    oddsMappingTtl: 10 * 60,
  });
  await job?.updateProgress?.({ phase: result.ok ? 'complete' : 'failed', ...result, startedAt });
  if (!result.ok) throw new Error(`baseball empirical analyze incompleto: ${result.failed}/${result.total}`);
  return { ...result, durationSec: Math.round((Date.now() - startedAt) / 100) / 10 };
}
