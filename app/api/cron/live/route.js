/**
 * GET /api/cron/live
 * Runs every 1 minute during active hours.
 * Fetches live scores from API-Football, saves to Redis, pushes via Pusher.
 * NO Sanity — uses Redis + Supabase only.
 */
import { ALL_LEAGUE_IDS } from '../../../../lib/leagues';
import { triggerEvent } from '../../../../lib/pusher';
import { redisGet, redisSet, KEYS, TTL } from '../../../../lib/redis';
import { incrementApiCallCount } from '../../../../lib/sanity-cache';
import { sendPushNotification } from '../../../../lib/webpush';
import { supabaseAdmin } from '../../../../lib/supabase';
import { getMatchSchedule } from '../../../../lib/supabase-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 55;

const API_HOST = 'v3.football.api-sports.io';
const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];

function verifyCronAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret')
    || request.headers.get('authorization')?.replace('Bearer ', '');
  return secret === process.env.CRON_SECRET || request.headers.get('x-internal-trigger') === 'true' || process.env.NODE_ENV !== 'production';
}

async function apiFetch(endpoint) {
  const key = process.env.FOOTBALL_API_KEY;
  if (!key) return null;
  const res = await fetch(`https://${API_HOST}${endpoint}`, {
    headers: { 'x-apisports-key': key },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    console.error('[LIVE] API error:', data.errors);
    return null;
  }
  return data.response || [];
}

function extractLiveStats(match, events, stats) {
  const homeId = match.teams.home.id;
  const awayId = match.teams.away.id;
  const homeStats = (stats || []).find(s => s.team?.id === homeId);
  const awayStats = (stats || []).find(s => s.team?.id === awayId);

  const getVal = (teamStats, type) => {
    const stat = (teamStats?.statistics || []).find(s => s.type === type);
    return stat?.value || 0;
  };

  const goalScorers = [], cardEvents = [], missedPenalties = [];
  for (const ev of (events || [])) {
    if (ev.type === 'Goal') {
      if (ev.detail === 'Missed Penalty') {
        missedPenalties.push({ player: ev.player?.name, teamId: ev.team?.id, teamName: ev.team?.name, minute: ev.time?.elapsed, extra: ev.time?.extra });
      } else {
        goalScorers.push({ player: ev.player?.name, teamId: ev.team?.id, teamName: ev.team?.name, minute: ev.time?.elapsed, extra: ev.time?.extra, type: ev.detail });
      }
    }
    if (ev.type === 'Card') {
      cardEvents.push({ player: ev.player?.name, teamId: ev.team?.id, teamName: ev.team?.name, minute: ev.time?.elapsed, type: ev.detail });
    }
  }

  const hCorners = getVal(homeStats, 'Corner Kicks');
  const aCorners = getVal(awayStats, 'Corner Kicks');
  const hYellow = getVal(homeStats, 'Yellow Cards') || cardEvents.filter(e => e.teamId === homeId && e.type === 'Yellow Card').length;
  const aYellow = getVal(awayStats, 'Yellow Cards') || cardEvents.filter(e => e.teamId === awayId && e.type === 'Yellow Card').length;
  const hRed = getVal(homeStats, 'Red Cards') || cardEvents.filter(e => e.teamId === homeId && (e.type === 'Red Card' || e.type === 'Second Yellow card')).length;
  const aRed = getVal(awayStats, 'Red Cards') || cardEvents.filter(e => e.teamId === awayId && (e.type === 'Red Card' || e.type === 'Second Yellow card')).length;

  return {
    fixtureId: match.fixture.id,
    status: match.fixture.status,
    goals: match.goals,
    score: match.score,
    homeTeam: { id: homeId, name: match.teams.home.name },
    awayTeam: { id: awayId, name: match.teams.away.name },
    corners: { home: hCorners, away: aCorners, total: hCorners + aCorners },
    yellowCards: { home: hYellow, away: aYellow, total: hYellow + aYellow },
    redCards: { home: hRed, away: aRed, total: hRed + aRed },
    goalScorers,
    cardEvents,
    missedPenalties,
    updatedAt: new Date().toISOString(),
  };
}

async function sendGoalPushes(liveDetailsMap, existingLive) {
  const goals = [];
  for (const [fid, data] of Object.entries(liveDetailsMap)) {
    const prev = existingLive[fid];
    if (!prev?.goals) continue;
    const prevH = prev.goals.home ?? 0, prevA = prev.goals.away ?? 0;
    const newH = data.goals?.home ?? 0, newA = data.goals?.away ?? 0;
    if (newH > prevH || newA > prevA) {
      const lastScorer = data.goalScorers?.slice(-1)[0];
      goals.push({ fixtureId: Number(fid), homeTeam: data.homeTeam?.name || '?', awayTeam: data.awayTeam?.name || '?', homeScore: newH, awayScore: newA, scorer: lastScorer?.player, minute: lastScorer?.minute });
    }
  }
  if (goals.length === 0) return;

  // Load subscriptions from Supabase push_subscriptions table
  const { data: subs } = await supabaseAdmin
    .from('push_subscriptions')
    .select('user_id, subscription');
  if (!subs?.length) return;

  // Preload hidden lists per user
  const hiddenByUser = {};
  await Promise.all(subs.map(async (row) => {
    if (hiddenByUser[row.user_id] !== undefined) return;
    const cached = await redisGet(KEYS.userHidden(row.user_id));
    if (Array.isArray(cached)) {
      hiddenByUser[row.user_id] = cached;
    } else {
      const { data: hiddenRows } = await supabaseAdmin
        .from('user_hidden')
        .select('fixture_id')
        .eq('user_id', row.user_id);
      hiddenByUser[row.user_id] = (hiddenRows || []).map(r => r.fixture_id);
    }
  }));

  for (const goal of goals) {
    const title = `⚽ GOL! ${goal.homeTeam} ${goal.homeScore}-${goal.awayScore} ${goal.awayTeam}`;
    const body = goal.scorer ? `${goal.scorer} · min. ${goal.minute}` : `min. ${goal.minute || '?'}`;
    await Promise.allSettled(subs.map(async (row) => {
      try {
        const userHidden = hiddenByUser[row.user_id] || [];
        if (userHidden.includes(goal.fixtureId)) return;
        const sub = typeof row.subscription === 'string' ? JSON.parse(row.subscription) : row.subscription;
        await sendPushNotification(sub, { title, body, tag: `goal-${goal.fixtureId}` });
      } catch {}
    }));
  }
}

export async function GET(request) {
  if (!verifyCronAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const now = Date.now();

    // Smart schedule check — skip if no matches active
    let schedule = await redisGet(KEYS.schedule(today));
    if (!schedule) {
      schedule = await getMatchSchedule(today).catch(() => null);
    }

    if (schedule) {
      const firstKickoff = schedule.firstKickoff ? Number(schedule.firstKickoff) : null;
      const lastExpectedEnd = schedule.lastExpectedEnd ? Number(schedule.lastExpectedEnd) : null;

      if (!schedule.kickoffTimes || schedule.kickoffTimes.length === 0) {
        return Response.json({ success: true, skipped: true, reason: 'No fixtures scheduled today', apiCalls: 0, timestamp: new Date().toISOString() });
      }
      if (firstKickoff && now < firstKickoff - 5 * 60 * 1000) {
        return Response.json({ success: true, skipped: true, reason: `Before first kickoff`, nextCheck: new Date(firstKickoff - 5 * 60 * 1000).toISOString(), apiCalls: 0, timestamp: new Date().toISOString() });
      }
      if (lastExpectedEnd && now > lastExpectedEnd + 30 * 60 * 1000) {
        return Response.json({ success: true, skipped: true, reason: 'After last expected end + 30min', apiCalls: 0, timestamp: new Date().toISOString() });
      }

      const hasActiveMatch = schedule.kickoffTimes.some(m => {
        const kickoff = Number(m.kickoff);
        const expectedEnd = Number(m.expectedEnd);
        return now >= kickoff - 5 * 60 * 1000 && now <= expectedEnd;
      });

      if (!hasActiveMatch) {
        const lastRun = await redisGet('live-cron:last-run');
        if (lastRun && Number(lastRun) > now - 10 * 60 * 1000) {
          return Response.json({ success: true, skipped: true, reason: 'No active matches in window', apiCalls: 0, timestamp: new Date().toISOString() });
        }
        console.log('[LIVE-CRON] Safety net: running despite no active match');
      }
    }

    await redisSet('live-cron:last-run', String(now), 600);

    const allLive = await apiFetch('/fixtures?live=all');
    let apiCalls = 1;

    if (!allLive) {
      return Response.json({ success: false, error: 'API fetch failed', timestamp: new Date().toISOString() });
    }

    const YOUTH_RE = /\bU-?1[2-9]\b|\bU-?2[0-3]\b|\bunder[ -]?(1[2-9]|2[0-3])\b|\byouth\b|\bjunior\b|\bsub-?(1[2-9]|2[0-3])\b/i;
    const tracked = allLive.filter(m => ALL_LEAGUE_IDS.includes(m.league.id) && !YOUTH_RE.test(m.league.name || ''));

    const liveDetailsMap = {};
    for (const match of tracked) {
      const fid = match.fixture.id;
      const liveData = extractLiveStats(match, match.events || [], match.statistics || []);
      liveData.date = today;
      liveDetailsMap[fid] = liveData;

      // For finished matches, persist stats with 48h TTL
      if (FINISHED_STATUSES.includes(match.fixture.status.short)) {
        liveData.savedAt = new Date().toISOString();
        await redisSet(KEYS.fixtureStats(fid), liveData, TTL.yesterday);
      }
    }

    const existingLive = await redisGet(KEYS.liveStats(today)) || {};

    // Fetch events for matches with goals but empty events[] (some leagues don't include them)
    const needsEventsFetch = tracked.filter(m => {
      const fid = m.fixture.id;
      const totalGoals = (m.goals?.home || 0) + (m.goals?.away || 0);
      if (totalGoals === 0 || (m.events || []).length > 0) return false;
      const cached = existingLive[fid];
      if (cached?.goalScorers?.length > 0 && ((cached.goals?.home || 0) + (cached.goals?.away || 0)) === totalGoals) return false;
      return true;
    });

    if (needsEventsFetch.length > 0) {
      await Promise.all(needsEventsFetch.map(async (match) => {
        const fid = match.fixture.id;
        const data = await apiFetch(`/fixtures?id=${fid}`);
        apiCalls++;
        if (data?.[0]) {
          const full = data[0];
          const fullData = extractLiveStats(full, full.events || [], full.statistics || []);
          fullData.date = today;
          liveDetailsMap[fid] = fullData;
        }
      }));
    }

    // Send goal push notifications (fire and forget)
    sendGoalPushes(liveDetailsMap, existingLive).catch(err => console.error('[LIVE-CRON:pushes]', err.message));

    // Merge live data (preserve goalScorers from existing if new data has none)
    const mergedLive = { ...existingLive };
    for (const [fid, data] of Object.entries(liveDetailsMap)) {
      const existing = existingLive[fid];
      mergedLive[fid] = {
        ...data,
        goalScorers: data.goalScorers?.length > 0 ? data.goalScorers : (existing?.goalScorers || []),
        missedPenalties: data.missedPenalties?.length > 0 ? data.missedPenalties : (existing?.missedPenalties || []),
      };
    }

    // Save individual fixture stats
    if (Object.keys(liveDetailsMap).length > 0) {
      await Promise.all(
        Object.entries(liveDetailsMap).map(([fid, data]) =>
          redisSet(KEYS.fixtureStats(fid), data, TTL.fixtureStats)
        )
      );
    }

    // Detect stale matches (were live in cache, dropped from live feed)
    const finishedUpdates = [];
    let staleFixedCount = 0;
    const LIVE_STATUSES = ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'];
    const currentLiveIds = new Set(tracked.map(m => m.fixture.id));

    const staleIds = Object.entries(existingLive)
      .filter(([fid, m]) => LIVE_STATUSES.includes(m.status?.short) && !currentLiveIds.has(Number(fid)))
      .map(([fid]) => Number(fid));

    if (staleIds.length > 0) {
      // Load fixtures from Redis to find stale match objects
      const cachedFixtures = await redisGet(KEYS.fixtures(today));
      const fixturesList = cachedFixtures || [];

      await Promise.all(staleIds.map(async (fid) => {
        const data = await apiFetch(`/fixtures?id=${fid}`);
        apiCalls++;
        if (data?.[0]) {
          const fresh = data[0];
          const freshStatus = fresh.fixture.status.short;
          if (FINISHED_STATUSES.includes(freshStatus)) {
            const fullStats = extractLiveStats(fresh, fresh.events || [], fresh.statistics || []);
            fullStats.date = today;
            fullStats.savedAt = new Date().toISOString();
            await redisSet(KEYS.fixtureStats(fid), fullStats, TTL.yesterday);
            mergedLive[fid] = { ...fullStats, status: fresh.fixture.status };
            staleFixedCount++;
            finishedUpdates.push({ fixtureId: fid, status: fresh.fixture.status, goals: fresh.goals, score: fresh.score, corners: fullStats.corners, yellowCards: fullStats.yellowCards, redCards: fullStats.redCards, goalScorers: fullStats.goalScorers || [], missedPenalties: fullStats.missedPenalties || [] });
          } else {
            finishedUpdates.push({ fixtureId: fid, status: fresh.fixture.status, goals: fresh.goals, score: fresh.score });
          }
        }
      }));
    }

    // Save merged live data
    if (Object.keys(mergedLive).length > 0) {
      await redisSet(KEYS.liveStats(today), mergedLive, TTL.liveStats);
    }

    // Push real-time update via Pusher
    const allPusherUpdates = [];
    tracked.forEach(m => {
      const fid = m.fixture.id;
      const details = liveDetailsMap[fid];
      const merged = mergedLive[fid];
      allPusherUpdates.push({
        fixtureId: fid,
        status: m.fixture.status,
        goals: m.goals,
        score: m.score,
        corners: merged?.corners?.total > 0 ? merged.corners : (details?.corners || null),
        yellowCards: details?.yellowCards || null,
        redCards: details?.redCards || null,
        goalScorers: details?.goalScorers || [],
        missedPenalties: details?.missedPenalties || [],
      });
    });
    allPusherUpdates.push(...finishedUpdates);

    if (allPusherUpdates.length > 0) {
      await triggerEvent('live-scores', 'update', {
        date: today, liveCount: tracked.length, matches: allPusherUpdates, timestamp: new Date().toISOString(),
      });
    }

    for (let i = 0; i < apiCalls; i++) await incrementApiCallCount();

    return Response.json({
      success: true, liveCount: tracked.length, totalLive: allLive.length, staleFixed: staleFixedCount, apiCalls, updated: tracked.length > 0 || staleFixedCount > 0, timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[LIVE] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
