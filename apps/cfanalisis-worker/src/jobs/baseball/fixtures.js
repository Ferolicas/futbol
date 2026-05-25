// @ts-nocheck
/**
 * Job: baseball-fixtures
 * Port of /api/cron/baseball/fixtures. Fetches MLB fixtures and saves schedule.
 *
 * Payload: { date?: 'YYYY-MM-DD' }
 */
import { getBaseballFixturesByDate, getBaseballQuota, supabaseAdmin } from '../../shared.js';

export async function runBaseballFixtures(payload = {}) {
  // MISMA LÓGICA QUE futbol/fixtures.js: UTC con anticipo a "mañana" cuando
  // ya pasamos las 22 UTC. Esto es timezone-agnóstico para el usuario — el
  // frontend (/api/baseball/fixtures con ?tz=) filtra después por el día
  // local del cliente y trae cross-midnight via adjacentDates. Aquí solo
  // garantizamos que la cartelera del día (UTC, jornada deportiva) esté
  // poblada y persistida antes de las 02:10 España, cuando arranca el
  // analyze (gemelo de futbol-daily).
  //
  // Antes: TZ Bogotá → a las 01:05 ES (=19:05 CO del día anterior) caía
  // siempre el día N-1 → buscaba games del 24 cuando ya eran del 25 →
  // se quedaba todo sin analizar (el bug que el usuario vio a las 7am).
  const now = new Date();
  const utcHour = now.getUTCHours();
  const todayUTC    = now.toISOString().split('T')[0];
  const tomorrowUTC = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
  const targetDate = payload.date || (utcHour >= 22 ? tomorrowUTC : todayUTC);
  console.log(`[job:baseball-fixtures] targetDate=${targetDate} (utcHour=${utcHour})`);

  const result = await getBaseballFixturesByDate(targetDate, { forceApi: true });
  const fixtures = result.fixtures || [];

  const kickoffTimes = fixtures.map(f => {
    const kickoff = new Date(f.date || f.fixture?.date).getTime();
    return { fixtureId: f.id || f.fixture?.id, kickoff, expectedEnd: kickoff + 210 * 60 * 1000 };
  }).sort((a, b) => a.kickoff - b.kickoff);

  const scheduleData = {
    kickoffTimes,
    firstKickoff: kickoffTimes[0]?.kickoff || null,
    lastExpectedEnd: kickoffTimes.length > 0 ? Math.max(...kickoffTimes.map(k => k.expectedEnd)) : null,
    fixtureCount: fixtures.length,
  };

  await supabaseAdmin
    .from('baseball_match_schedule')
    .upsert({ date: targetDate, schedule: scheduleData, updated_at: new Date().toISOString() });

  const quota = await getBaseballQuota();
  return { ok: true, targetDate, fixtureCount: fixtures.length, quota };
}
