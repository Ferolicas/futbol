// @ts-nocheck
/**
 * Job: futbol-live
 * Port of /api/cron/live. Polls live fixtures from API-Football, persists
 * stats to Redis + Supabase, sends Pusher updates and push notifications
 * for goals on favorited matches.
 *
 * Payload: {}
 */
import {
  ALL_LEAGUE_IDS, triggerEvent,
  redisGet, redisSet, KEYS, TTL,
  incrementApiCallCount, sendPushNotification,
  supabaseAdmin, getMatchSchedule,
} from '../../shared.js';

const API_HOST = 'v3.football.api-sports.io';
const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];
const LIVE_STATUSES = ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'];

async function apiFetch(endpoint) {
  const key = process.env.FOOTBALL_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://${API_HOST}${endpoint}`, {
      headers: { 'x-apisports-key': key },
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.errors && Object.keys(data.errors).length > 0) {
      console.error('[live] API error:', data.errors);
      return null;
    }
    return data.response || [];
  } catch (e) {
    console.error('[live] apiFetch network error:', endpoint, e.message);
    return null;
  }
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

function toSubArray(stored) {
  if (!stored) return [];
  const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
  return Array.isArray(parsed) ? parsed : [parsed];
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

  const { data: subs } = await supabaseAdmin.from('push_subscriptions').select('user_id, subscription');
  if (!subs?.length) return;

  const favoritesByUser = {};
  await Promise.all(subs.map(async (row) => {
    if (favoritesByUser[row.user_id] !== undefined) return;
    const { data: favRows } = await supabaseAdmin
      .from('user_favorites')
      .select('fixture_id')
      .eq('user_id', row.user_id);
    favoritesByUser[row.user_id] = (favRows || []).map(r => r.fixture_id);
  }));

  const expiredByUser = {};

  for (const goal of goals) {
    const title = `⚽ GOL! ${goal.homeTeam} ${goal.homeScore}-${goal.awayScore} ${goal.awayTeam}`;
    const body = goal.scorer ? `${goal.scorer} · min. ${goal.minute}` : `min. ${goal.minute || '?'}`;
    await Promise.allSettled(subs.map(async (row) => {
      const userFavorites = favoritesByUser[row.user_id] || [];
      if (!userFavorites.includes(goal.fixtureId)) return;

      const deviceSubs = toSubArray(row.subscription);
      await Promise.allSettled(deviceSubs.map(async (sub) => {
        if (!sub?.endpoint) return;
        const result = await sendPushNotification(sub, { title, body, tag: `goal-${goal.fixtureId}` });
        if (result === 'expired') {
          if (!expiredByUser[row.user_id]) expiredByUser[row.user_id] = new Set();
          expiredByUser[row.user_id].add(sub.endpoint);
        }
      }));
    }));
  }

  const usersWithExpired = Object.keys(expiredByUser);
  if (usersWithExpired.length === 0) return;

  await Promise.allSettled(usersWithExpired.map(async (userId) => {
    try {
      const expiredEndpoints = expiredByUser[userId];
      const { data: row } = await supabaseAdmin
        .from('push_subscriptions')
        .select('subscription')
        .eq('user_id', userId)
        .maybeSingle();
      if (!row) return;

      const remaining = toSubArray(row.subscription).filter(s => !expiredEndpoints.has(s?.endpoint));

      if (remaining.length === 0) {
        await supabaseAdmin.from('push_subscriptions').delete().eq('user_id', userId);
      } else {
        await supabaseAdmin.from('push_subscriptions').update({ subscription: remaining }).eq('user_id', userId);
      }
    } catch (e) {
      console.error('[push:purge-expired]', userId, e.message);
    }
  }));
}

export async function runLive(_payload = {}) {
  const today = new Date().toISOString().split('T')[0];
  const now = Date.now();

  // Smart schedule check — skip if no matches active
  let schedule = await redisGet(KEYS.schedule(today));
  if (!schedule) schedule = await getMatchSchedule(today).catch(() => null);

  if (schedule) {
    const firstKickoff = schedule.firstKickoff ? Number(schedule.firstKickoff) : null;
    const lastExpectedEnd = schedule.lastExpectedEnd ? Number(schedule.lastExpectedEnd) : null;

    if (!schedule.kickoffTimes || schedule.kickoffTimes.length === 0) {
      return { ok: true, skipped: true, reason: 'no fixtures scheduled today', apiCalls: 0 };
    }
    if (firstKickoff && now < firstKickoff - 5 * 60 * 1000) {
      return { ok: true, skipped: true, reason: 'before first kickoff', apiCalls: 0 };
    }
    if (lastExpectedEnd && now > lastExpectedEnd + 30 * 60 * 1000) {
      return { ok: true, skipped: true, reason: 'after last expected end + 30min', apiCalls: 0 };
    }

    const hasActiveMatch = schedule.kickoffTimes.some(m => {
      const kickoff = Number(m.kickoff);
      const expectedEnd = Number(m.expectedEnd);
      return now >= kickoff - 5 * 60 * 1000 && now <= expectedEnd;
    });

    if (!hasActiveMatch) {
      const lastRun = await redisGet('live-cron:last-run');
      if (lastRun && Number(lastRun) > now - 10 * 60 * 1000) {
        return { ok: true, skipped: true, reason: 'no active matches in window', apiCalls: 0 };
      }
    }
  }

  await redisSet('live-cron:last-run', String(now), 600);

  const allLive = await apiFetch('/fixtures?live=all');
  let apiCalls = 1;
  if (!allLive) return { ok: false, error: 'API fetch failed' };

  const YOUTH_RE = /\bU-?1[2-9]\b|\bU-?2[0-3]\b|\bunder[ -]?(1[2-9]|2[0-3])\b|\byouth\b|\bjunior\b|\bsub-?(1[2-9]|2[0-3])\b/i;
  const tracked = allLive.filter(m => ALL_LEAGUE_IDS.includes(m.league.id) && !YOUTH_RE.test(m.league.name || ''));

  const liveDetailsMap = {};
  for (const match of tracked) {
    const fid = match.fixture.id;
    const liveData = extractLiveStats(match, match.events || [], match.statistics || []);
    liveData.date = today;
    liveDetailsMap[fid] = liveData;

    if (FINISHED_STATUSES.includes(match.fixture.status.short)) {
      liveData.savedAt = new Date().toISOString();
      await redisSet(KEYS.fixtureStats(fid), liveData, TTL.yesterday);
      supabaseAdmin.from('match_analysis')
        .update({ live_stats: liveData })
        .eq('fixture_id', fid)
        .then(() => {})
        .catch(e => console.error(`[live] supabase stats save ${fid}:`, e.message));
    }
  }

  const existingLive = (await redisGet(KEYS.liveStats(today))) || {};

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

  const alreadyFetched = new Set(needsEventsFetch.map(m => m.fixture.id));
  const needsStatsFetch = tracked.filter(m => {
    const fid = m.fixture.id;
    if (alreadyFetched.has(fid)) return false;
    const elapsed = m.fixture?.status?.elapsed || 0;
    if (elapsed < 10) return false;
    const hasStats = (m.statistics || []).length > 0;
    if (hasStats) return false;
    const cached = existingLive[fid];
    if (cached?.corners?.total > 0) return false;
    return true;
  });

  if (needsStatsFetch.length > 0) {
    await Promise.all(needsStatsFetch.map(async (match) => {
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

  // Fire-and-forget goal pushes
  sendGoalPushes(liveDetailsMap, existingLive).catch(err => console.error('[live:pushes]', err.message));

  const mergedLive = { ...existingLive };
  for (const [fid, data] of Object.entries(liveDetailsMap)) {
    const existing = existingLive[fid];
    mergedLive[fid] = {
      ...data,
      corners: data.corners?.total > 0 ? data.corners : (existing?.corners || data.corners),
      goalScorers: data.goalScorers?.length > 0 ? data.goalScorers : (existing?.goalScorers || []),
      missedPenalties: data.missedPenalties?.length > 0 ? data.missedPenalties : (existing?.missedPenalties || []),
    };
  }

  if (Object.keys(liveDetailsMap).length > 0) {
    await Promise.all(
      Object.entries(liveDetailsMap).map(([fid, data]) =>
        redisSet(KEYS.fixtureStats(fid), data, TTL.fixtureStats)
      )
    );
  }

  // Stale match detection
  const finishedUpdates = [];
  let staleFixedCount = 0;
  const currentLiveIds = new Set(tracked.map(m => m.fixture.id));

  const staleIds = Object.entries(existingLive)
    .filter(([fid, m]) => LIVE_STATUSES.includes(m.status?.short) && !currentLiveIds.has(Number(fid)))
    .map(([fid]) => Number(fid));

  if (staleIds.length > 0) {
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
          supabaseAdmin.from('match_analysis')
            .update({ live_stats: fullStats })
            .eq('fixture_id', fid)
            .catch(e => console.error(`[live:stale] supabase stats save ${fid}:`, e.message));
          mergedLive[fid] = { ...fullStats, status: fresh.fixture.status };
          staleFixedCount++;
          finishedUpdates.push({ fixtureId: fid, status: fresh.fixture.status, goals: fresh.goals, score: fresh.score, corners: fullStats.corners, yellowCards: fullStats.yellowCards, redCards: fullStats.redCards, goalScorers: fullStats.goalScorers || [], missedPenalties: fullStats.missedPenalties || [] });
        } else {
          finishedUpdates.push({ fixtureId: fid, status: fresh.fixture.status, goals: fresh.goals, score: fresh.score });
        }
      }
    }));
  }

  if (Object.keys(mergedLive).length > 0) {
    await redisSet(KEYS.liveStats(today), mergedLive, TTL.liveStats);
  }

  // Update fixtures:{date} with latest status
  const allUpdatedIds = new Set([...tracked.map(m => m.fixture.id), ...staleIds]);
  if (allUpdatedIds.size > 0) {
    const cachedFixtures = await redisGet(KEYS.fixtures(today));
    if (Array.isArray(cachedFixtures) && cachedFixtures.length > 0) {
      let changed = false;
      const updated = cachedFixtures.map(f => {
        const fid = f.fixture?.id;
        if (!fid || !allUpdatedIds.has(fid)) return f;
        const live = mergedLive[fid];
        if (!live?.status) return f;
        if (f.fixture.status.short === live.status.short &&
            (f.fixture.status.elapsed || 0) >= (live.status.elapsed || 0)) return f;
        changed = true;
        return { ...f, fixture: { ...f.fixture, status: live.status }, goals: live.goals || f.goals, score: live.score || f.score };
      });
      if (changed) redisSet(KEYS.fixtures(today), updated, TTL.fixtures).catch(() => {});
    }
  }

  // Pusher update
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

  return {
    ok: true,
    liveCount: tracked.length,
    totalLive: allLive.length,
    staleFixed: staleFixedCount,
    apiCalls,
  };
}
