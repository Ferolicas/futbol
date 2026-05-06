/**
 * GET /api/cron/baseball/live
 *
 * Smart live updater for baseball games. The cron-job.org schedule should poll
 * this endpoint every 5 minutes — but the endpoint itself decides whether to
 * actually spend an API call, using a daily budget and dynamic spacing.
 *
 * Quota math (100 calls/day total):
 *   - fixtures cron: 1 call/day
 *   - analyze cron: ~4 calls × N partidos analizados (cap implícito en analyze)
 *   - live cron: budgeted to LIVE_BUDGET (default 30/day)
 *   - safety reserve: 5 calls
 *
 * Algorithm:
 *   1. Skip if outside game window (cheap, no API call).
 *   2. Skip if quota.remaining < SAFETY_RESERVE.
 *   3. Skip if liveCallsToday >= LIVE_BUDGET.
 *   4. Compute dynamic_interval = remaining_window_minutes / live_calls_remaining,
 *      clamped to [MIN_INTERVAL, MAX_INTERVAL].
 *   5. Skip if (now - lastCallAt) < dynamic_interval.
 *   6. Otherwise call /games?live=all (1 API call), update results, increment counter.
 *
 * Cron-job.org schedule: "*\/5 * * * *"  (every 5 minutes — endpoint regulates spend).
 */
import { getBaseballLiveGames, getBaseballQuota } from '../../../../../lib/api-baseball';
import { supabaseAdmin } from '../../../../../lib/supabase';
import { redisGet, redisSet } from '../../../../../lib/redis';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Budget knobs — tune these without touching logic
const LIVE_BUDGET = 30;          // calls/day reserved for live updates
const SAFETY_RESERVE = 5;        // never spend below this many remaining
const MIN_INTERVAL_MIN = 4;      // minimum minutes between live calls
const MAX_INTERVAL_MIN = 30;     // never wait longer than this when in window
const PRE_KICKOFF_BUFFER_MIN = 5; // start polling N min before first kickoff

function verifyAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret') || request.headers.get('authorization')?.replace('Bearer ', '');
  return secret === process.env.CRON_SECRET || process.env.NODE_ENV !== 'production';
}

const todayISO = () => new Date().toISOString().split('T')[0];
const callsKey = (d) => `baseball:live:calls:${d}`;
const lastCallKey = 'baseball:live:last_call_at';

export async function GET(request) {
  if (!verifyAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const today = todayISO();
    const now = Date.now();

    // ───────── 1. Window check (free)
    const { data: scheduleRow } = await supabaseAdmin
      .from('baseball_match_schedule')
      .select('schedule')
      .eq('date', today)
      .maybeSingle();

    const schedule = scheduleRow?.schedule;
    if (!schedule || !schedule.firstKickoff || !schedule.lastExpectedEnd) {
      return Response.json({ skipped: true, reason: 'No schedule for today' });
    }

    const windowStart = schedule.firstKickoff - PRE_KICKOFF_BUFFER_MIN * 60 * 1000;
    const windowEnd = schedule.lastExpectedEnd;
    if (now < windowStart || now > windowEnd) {
      return Response.json({
        skipped: true,
        reason: 'Outside game window',
        window: {
          start: new Date(windowStart).toISOString(),
          end: new Date(windowEnd).toISOString(),
          now: new Date(now).toISOString(),
        },
      });
    }

    // ───────── 2. Quota check
    const quota = await getBaseballQuota();
    if (quota.remaining <= SAFETY_RESERVE) {
      return Response.json({
        skipped: true,
        reason: `Quota too low (${quota.remaining} remaining, reserve=${SAFETY_RESERVE})`,
        quota,
      });
    }

    // ───────── 3. Live budget check
    const liveCallsToday = Number((await redisGet(callsKey(today))) || 0);
    if (liveCallsToday >= LIVE_BUDGET) {
      return Response.json({
        skipped: true,
        reason: `Live budget exhausted (${liveCallsToday}/${LIVE_BUDGET})`,
        liveCallsToday,
      });
    }

    // ───────── 4. Dynamic interval
    const callsRemaining = Math.max(1, LIVE_BUDGET - liveCallsToday);
    const minutesUntilEnd = Math.max(1, (windowEnd - now) / 60000);
    let intervalMin = minutesUntilEnd / callsRemaining;
    intervalMin = Math.max(MIN_INTERVAL_MIN, Math.min(MAX_INTERVAL_MIN, intervalMin));
    const intervalMs = intervalMin * 60 * 1000;

    // ───────── 5. Throttle check
    const lastCallAt = Number(await redisGet(lastCallKey)) || 0;
    const sinceLastMs = now - lastCallAt;
    if (lastCallAt && sinceLastMs < intervalMs) {
      const nextEligibleAt = lastCallAt + intervalMs;
      return Response.json({
        skipped: true,
        reason: 'Throttled',
        intervalMin: +intervalMin.toFixed(1),
        nextEligibleIn: Math.round((nextEligibleAt - now) / 1000),
        liveCallsToday,
        callsRemaining,
        quota,
      });
    }

    // ───────── 6. Make the call
    const liveGames = await getBaseballLiveGames();

    let updated = 0;
    for (const g of liveGames) {
      const fid = g.id;
      const homeScore = g.scores?.home?.total ?? null;
      const awayScore = g.scores?.away?.total ?? null;
      const homeHits = g.scores?.home?.hits ?? null;
      const awayHits = g.scores?.away?.hits ?? null;
      const homeErrors = g.scores?.home?.errors ?? null;
      const awayErrors = g.scores?.away?.errors ?? null;
      const innings = g.scores?.home?.innings || g.innings || null;

      await supabaseAdmin.from('baseball_match_results').upsert({
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
      updated++;
    }

    // Update counters (TTL 36h, expira al día siguiente)
    await redisSet(callsKey(today), liveCallsToday + 1, 36 * 3600);
    await redisSet(lastCallKey, now, 36 * 3600);

    return Response.json({
      success: true,
      liveCount: liveGames.length,
      updated,
      intervalMin: +intervalMin.toFixed(1),
      liveCallsToday: liveCallsToday + 1,
      callsRemaining: callsRemaining - 1,
      quota: await getBaseballQuota(),
    });
  } catch (e) {
    console.error('[CRON:baseball/live]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
