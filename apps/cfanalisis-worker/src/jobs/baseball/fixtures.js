// @ts-nocheck
/**
 * Job: baseball-fixtures
 * Port of /api/cron/baseball/fixtures. Fetches MLB fixtures and saves schedule.
 *
 * Payload: { date?: 'YYYY-MM-DD' }
 */
import { getBaseballFixturesByDate, getBaseballQuota, supabaseAdmin } from '../../shared.js';

export async function runBaseballFixtures(payload = {}) {
  // BUG anterior: usaba fecha Colombia. El cron corre 01:05 hora España (CET),
  // que son 19:05 del día ANTERIOR Colombia (UTC-5). Como MLB programa los
  // games en hora US, esto resultaba en buscar games del "ayer" Colombia
  // mientras los reales (las 14 que el usuario ve a las 7am España) estaban
  // bajo la fecha del "hoy" Colombia / "hoy" ET. El cron pasaba sin encontrar
  // nada y por eso aparecen sin analizar.
  //
  // Fix: usar hora US/Eastern (America/New_York) que es donde MLB programa
  // sus juegos. A las 01:05 España (19:05 ET del día N-1 entre Mar-Nov), un
  // game MLB nocturno de "hoy" ET (que arranca ~19:00 ET) aún tiene su date
  // bajo el día N-1 ET → el cron lo encuentra correctamente.
  //
  // Si el frontend muestra la fecha local del usuario y NO coincide, el
  // matcher por fixtureId basta — la fecha es solo clave de cache.
  const targetDate = payload.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  console.log(`[job:baseball-fixtures] targetDate=${targetDate} (America/New_York)`);

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
