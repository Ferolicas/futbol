/**
 * lib/supabase-cache.js — SOLO match schedule (Redis L1 + Postgres VPS L2).
 *
 * Limpieza de auditoría (MO2): este archivo tenía además funciones de caché de
 * fixtures/analysis/app_config que estaban MUERTAS (el worker usa lib/sanity-cache.js
 * para eso; aquí solo se importaban saveMatchSchedule/getMatchSchedule). Se eliminaron
 * las funciones muertas para que no haya dos cachés divergiendo. Si en el futuro se
 * unifica, mover esto a un único `content-cache.js`.
 */
import { supabaseAdmin } from './supabase';
import { redisGet, redisSet } from './redis';

export async function getMatchSchedule(date) {
  // Redis first
  const cached = await redisGet(`schedule:${date}`);
  if (cached) return cached;

  const { data, error } = await supabaseAdmin
    .from('match_schedule')
    .select('*')
    .eq('date', date)
    .single();

  if (error || !data) return null;

  const schedule = {
    kickoffTimes: data.kickoff_times,
    firstKickoff: data.first_kickoff,
    lastExpectedEnd: data.last_expected_end,
    fixtureCount: data.fixture_count,
  };

  await redisSet(`schedule:${date}`, schedule, 6 * 3600).catch(() => {});
  return schedule;
}

export async function saveMatchSchedule(date, schedule) {
  await redisSet(`schedule:${date}`, schedule, 6 * 3600).catch(() => {});

  const { error } = await supabaseAdmin
    .from('match_schedule')
    .upsert({
      date,
      kickoff_times: schedule.kickoffTimes || [],
      first_kickoff: schedule.firstKickoff || null,
      last_expected_end: schedule.lastExpectedEnd || null,
      fixture_count: schedule.fixtureCount || schedule.kickoffTimes?.length || 0,
    }, { onConflict: 'date' });

  if (error) console.error('[supabase-cache:saveMatchSchedule]', error.message);
}
