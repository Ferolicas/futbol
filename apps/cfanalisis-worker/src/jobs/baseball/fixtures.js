// @ts-nocheck
/**
 * Job: baseball-fixtures (MLB, MLB Stats API)
 *
 * Cachea el schedule del día MLB en baseball_match_schedule (cartelera + ventana
 * de juego). El analyze y el live obtienen el schedule directo de MLB Stats API,
 * así que esto es sobre todo para que el frontend liste rápido los juegos del
 * día y para tener la ventana firstKickoff/lastExpectedEnd.
 *
 * Payload: { date?: 'YYYY-MM-DD' }
 */
import { getMlbScheduleByDate, MLB_SPORT_IDS, cronTargetDate, supabaseAdmin } from '../../shared.js';

const SPORT_IDS = Object.keys(MLB_SPORT_IDS).map(Number);
const GAME_DURATION_MIN = 210; // ~3.5h cubre extra innings

export async function runBaseballFixtures(payload = {}) {
  // Misma jornada Colombia objetivo que baseball-analyze (alineado con fútbol).
  const targetDate = payload.date || cronTargetDate();
  console.log(`[job:baseball-fixtures] MLB targetDate=${targetDate}`);

  let games = [];
  try { games = await getMlbScheduleByDate(targetDate, SPORT_IDS); }
  catch (e) { console.warn(`[baseball-fixtures] schedule MLB: ${e.message}`); }

  const kickoffTimes = games.map(g => {
    const kickoff = new Date(g.dateUTC).getTime();
    return { fixtureId: g.gamePk, kickoff, expectedEnd: kickoff + GAME_DURATION_MIN * 60 * 1000 };
  }).filter(k => Number.isFinite(k.kickoff)).sort((a, b) => a.kickoff - b.kickoff);

  const scheduleData = {
    kickoffTimes,
    firstKickoff: kickoffTimes[0]?.kickoff || null,
    lastExpectedEnd: kickoffTimes.length > 0 ? Math.max(...kickoffTimes.map(k => k.expectedEnd)) : null,
    fixtureCount: games.length,
  };

  await supabaseAdmin
    .from('baseball_match_schedule')
    .upsert({ date: targetDate, schedule: scheduleData, updated_at: new Date().toISOString() }, { onConflict: 'date' });

  return { ok: true, targetDate, fixtureCount: games.length };
}
