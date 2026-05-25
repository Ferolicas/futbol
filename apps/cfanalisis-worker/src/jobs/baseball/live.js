// @ts-nocheck
/**
 * Job: baseball-live
 * Port of /api/cron/baseball/live. Smart live updater with daily budget +
 * dynamic spacing. Runs every 5 minutes via cron-job.org → enqueue; the
 * handler itself decides whether to actually spend an API call.
 *
 * Payload: {}
 */
import { getBaseballLiveGames, getBaseballQuota, supabaseAdmin, redisGet, redisSet } from '../../shared.js';
import { mapPool } from '../../pool.js';

const LIVE_BUDGET = 30;
const SAFETY_RESERVE = 5;
const MIN_INTERVAL_MIN = 4;
const MAX_INTERVAL_MIN = 30;
const PRE_KICKOFF_BUFFER_MIN = 5;

// Fecha UTC con anticipo a "mañana" tras las 22 UTC — DEBE coincidir con la
// lógica de baseball-fixtures y baseball-analyze (los 3 jobs usan la misma
// función de fecha para que live encuentre el schedule que fixtures guardó).
// El nombre `bogotaDate` se conserva por uso interno; ya no es Bogotá.
const bogotaDate = () => {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const todayUTC    = now.toISOString().split('T')[0];
  const tomorrowUTC = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
  return (utcHour >= 22 ? tomorrowUTC : todayUTC);
};
const callsKey = (d) => `baseball:live:calls:${d}`;
const lastCallKey = 'baseball:live:last_call_at';

export async function runBaseballLive(payload = {}) {
  const today = payload.date || bogotaDate();
  const now = Date.now();

  const { data: scheduleRow } = await supabaseAdmin
    .from('baseball_match_schedule')
    .select('schedule')
    .eq('date', today)
    .maybeSingle();

  const schedule = scheduleRow?.schedule;
  if (!schedule || !schedule.firstKickoff || !schedule.lastExpectedEnd) {
    return { ok: true, skipped: true, reason: 'no schedule for today' };
  }

  const windowStart = schedule.firstKickoff - PRE_KICKOFF_BUFFER_MIN * 60 * 1000;
  const windowEnd = schedule.lastExpectedEnd;
  if (now < windowStart || now > windowEnd) {
    return { ok: true, skipped: true, reason: 'outside game window' };
  }

  const quota = await getBaseballQuota();
  if (quota.remaining <= SAFETY_RESERVE) {
    return { ok: true, skipped: true, reason: `quota too low (${quota.remaining})`, quota };
  }

  const liveCallsToday = Number((await redisGet(callsKey(today))) || 0);
  if (liveCallsToday >= LIVE_BUDGET) {
    return { ok: true, skipped: true, reason: `live budget exhausted (${liveCallsToday}/${LIVE_BUDGET})`, liveCallsToday };
  }

  const callsRemaining = Math.max(1, LIVE_BUDGET - liveCallsToday);
  const minutesUntilEnd = Math.max(1, (windowEnd - now) / 60000);
  let intervalMin = minutesUntilEnd / callsRemaining;
  intervalMin = Math.max(MIN_INTERVAL_MIN, Math.min(MAX_INTERVAL_MIN, intervalMin));
  const intervalMs = intervalMin * 60 * 1000;

  const lastCallAt = Number(await redisGet(lastCallKey)) || 0;
  const sinceLastMs = now - lastCallAt;
  if (lastCallAt && sinceLastMs < intervalMs) {
    const nextEligibleAt = lastCallAt + intervalMs;
    return {
      ok: true,
      skipped: true,
      reason: 'throttled',
      intervalMin: +intervalMin.toFixed(1),
      nextEligibleIn: Math.round((nextEligibleAt - now) / 1000),
      liveCallsToday,
      callsRemaining,
      quota,
    };
  }

  // getBaseballLiveGames usa apiCall, que lanza ante cuota agotada (429) o
  // error de API. Lo tratamos como skip — igual que los demás smart-skips de
  // este handler — para no disparar alerta de Telegram cada 5 min.
  let liveGames;
  try {
    liveGames = await getBaseballLiveGames();
  } catch (e) {
    return { ok: true, skipped: true, reason: `API sin datos (${e.message})` };
  }

  const upsertResults = await mapPool(liveGames, 8, async (g) => {
    const fid = g.id;
    const homeScore = g.scores?.home?.total ?? null;
    const awayScore = g.scores?.away?.total ?? null;
    const homeHits = g.scores?.home?.hits ?? null;
    const awayHits = g.scores?.away?.hits ?? null;
    const homeErrors = g.scores?.home?.errors ?? null;
    const awayErrors = g.scores?.away?.errors ?? null;
    const innings = g.scores?.home?.innings || g.innings || null;

    const { error } = await supabaseAdmin.from('baseball_match_results').upsert({
      fixture_id: fid,
      league_id: g.league?.id,
      date: today,
      status: g.status?.short || g.status?.long,
      inning: g.status?.inning ?? null,
      inning_half: (g.status?.long || '').toLowerCase().includes('top') ? 'top' :
                   (g.status?.long || '').toLowerCase().includes('bottom') ? 'bottom' : null,
      home_score: homeScore,
      away_score: awayScore,
      home_hits: homeHits,
      away_hits: awayHits,
      home_errors: homeErrors,
      away_errors: awayErrors,
      innings,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`upsert: ${error.message || error}`);
    return fid;
  });
  const updated = upsertResults.filter(r => r.ok).length;
  const upsertFails = upsertResults.length - updated;
  if (upsertFails > 0) console.error(`[job:baseball-live] ${upsertFails}/${liveGames.length} upserts failed`);

  await redisSet(callsKey(today), liveCallsToday + 1, 36 * 3600);
  await redisSet(lastCallKey, now, 36 * 3600);

  return {
    ok: true,
    liveCount: liveGames.length,
    updated,
    intervalMin: +intervalMin.toFixed(1),
    liveCallsToday: liveCallsToday + 1,
    callsRemaining: callsRemaining - 1,
    quota: await getBaseballQuota(),
  };
}
