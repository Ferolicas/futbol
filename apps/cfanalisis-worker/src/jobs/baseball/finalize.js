// @ts-nocheck
/** Finaliza MLB e ingiere dos hechos empíricos independientes por partido. */
import { finalizeSportDate, bogotaToday } from '../../shared.js';

function addDays(date, amount) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
export async function runBaseballFinalize(payload = {}) {
  const today = payload.date || bogotaToday();
  const days = Number(payload.days) > 0 ? Math.min(Number(payload.days), 14) : 3;
  const summaries = [];
  for (let offset = days; offset >= 0; offset--) {
    summaries.push(await finalizeSportDate('baseball', addDays(today, -offset), {
      force: payload.force === true,
      concurrency: 3,
    }));
  }
  const failed = summaries.reduce((sum, item) => sum + item.failed, 0);
  if (failed) throw new Error(`baseball finalize incompleto: ${failed} juegos`);
  return {
    ok: true,
    finalized: summaries.reduce((sum, item) => sum + item.ingested, 0),
    alreadyIngested: summaries.reduce((sum, item) => sum + item.alreadyIngested, 0),
    dates: summaries.length,
  };
}
