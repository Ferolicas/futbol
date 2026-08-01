// @ts-nocheck
import { finalizeSportDate, bogotaToday } from '../../shared.js';

function addDays(date, amount) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

async function run(sport, payload) {
  const today = payload.date || bogotaToday();
  const dates = [addDays(today, -1), today];
  const reports = [];
  for (const date of dates) reports.push(await finalizeSportDate(sport, date, { force: payload.force === true, concurrency: 6 }));
  const failed = reports.reduce((sum, report) => sum + report.failed, 0);
  if (failed) throw new Error(`${sport} finalize incompleto: ${failed}`);
  return { ok: true, sport, ingested: reports.reduce((sum, report) => sum + report.ingested, 0), reports };
}

export const runBasketballFinalize = (payload = {}) => run('basketball', payload);
export const runAmericanFootballFinalize = (payload = {}) => run('american_football', payload);
