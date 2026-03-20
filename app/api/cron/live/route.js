import { getFromSanity, saveToSanity } from '../../../../lib/sanity';
import { ALL_LEAGUE_IDS } from '../../../../lib/leagues';
import { triggerEvent } from '../../../../lib/pusher';
import { redisGet, redisSet, KEYS, TTL } from '../../../../lib/redis';
import { incrementApiCallCount } from '../../../../lib/sanity-cache';

// Cron: runs every 1 minute during active hours
// cron-job.org: GET /api/cron/live?secret=CRON_SECRET

export const dynamic = 'force-dynamic';
export const maxDuration = 55;

const API_HOST = 'v3.football.api-sports.io';

// Only these statuses represent a FINISHED match — safe to persist in Sanity
const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];

function getApiKey() {
  return process.env.FOOTBALL_API_KEY;
}

function verifyCronAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret')
    || request.headers.get('authorization')?.replace('Bearer ', '');
  return secret === process.env.CRON_SECRET || process.env.NODE_ENV !== 'production';
}

async function apiFetch(endpoint) {
  const key = getApiKey();
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

  const goalScorers = [];
  const cardEvents = [];
  const missedPenalties = [];

  for (const ev of (events || [])) {
    if (ev.type === 'Goal') {
      if (ev.detail === 'Missed Penalty') {
        missedPenalties.push({
          player: ev.player?.name,
          teamId: ev.team?.id,
          teamName: ev.team?.name,
          minute: ev.time?.elapsed,
          extra: ev.time?.extra,
        });
      } else {
        goalScorers.push({
          player: ev.player?.name,
          teamId: ev.team?.id,
          teamName: ev.team?.name,
          minute: ev.time?.elapsed,
          extra: ev.time?.extra,
          type: ev.detail, // 'Normal Goal', 'Penalty', 'Own Goal'
        });
      }
    }
    if (ev.type === 'Card') {
      cardEvents.push({
        player: ev.player?.name,
        teamId: ev.team?.id,
        teamName: ev.team?.name,
        minute: ev.time?.elapsed,
        type: ev.detail, // 'Yellow Card', 'Red Card', 'Second Yellow card'
      });
    }
  }

  const hCorners = getVal(homeStats, 'Corner Kicks');
  const aCorners = getVal(awayStats, 'Corner Kicks');

  // Prefer statistics; fall back to counting from events (many leagues don't include stats in live=all)
  const hYellowStat = getVal(homeStats, 'Yellow Cards');
  const aYellowStat = getVal(awayStats, 'Yellow Cards');
  const hRedStat = getVal(homeStats, 'Red Cards');
  const aRedStat = getVal(awayStats, 'Red Cards');

  const hYellowEv = cardEvents.filter(e => e.teamId === homeId && e.type === 'Yellow Card').length;
  const aYellowEv = cardEvents.filter(e => e.teamId === awayId && e.type === 'Yellow Card').length;
  const hRedEv = cardEvents.filter(e => e.teamId === homeId && (e.type === 'Red Card' || e.type === 'Second Yellow card')).length;
  const aRedEv = cardEvents.filter(e => e.teamId === awayId && (e.type === 'Red Card' || e.type === 'Second Yellow card')).length;

  const hYellow = hYellowStat || hYellowEv;
  const aYellow = aYellowStat || aYellowEv;
  const hRed = hRedStat || hRedEv;
  const aRed = aRedStat || aRedEv;

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

export async function GET(request) {
  if (!verifyCronAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const now = Date.now();

    // ===== Smart schedule check — skip if no matches active =====
    // Try Redis first (faster), then Sanity as fallback
    let schedule = await redisGet(KEYS.schedule(today));
    if (!schedule) {
      schedule = await getFromSanity('matchSchedule', today);
    }

    // If no formal schedule exists, derive from footballFixturesCache
    let scheduleFixturesDoc = null;
    if (!schedule) {
      scheduleFixturesDoc = await getFromSanity('footballFixturesCache', today);
      const fixturesDoc = scheduleFixturesDoc;
      if (fixturesDoc?.fixtures && fixturesDoc.fixtures.length > 0) {
        const kickoffTimes = fixturesDoc.fixtures.map(f => {
          const kickoff = new Date(f.fixture.date).getTime();
          return {
            fixtureId: f.fixture.id,
            kickoff,
            expectedEnd: kickoff + 120 * 60 * 1000,
          };
        }).sort((a, b) => a.kickoff - b.kickoff);

        schedule = {
          kickoffTimes,
          firstKickoff: kickoffTimes[0].kickoff,
          lastExpectedEnd: Math.max(...kickoffTimes.map(k => k.expectedEnd)),
        };

        // Persist so future invocations don't re-derive
        await saveToSanity('matchSchedule', today, {
          date: today,
          ...schedule,
          fixtureCount: fixturesDoc.fixtures.length,
          createdAt: new Date().toISOString(),
          derivedFrom: 'fixturesCache',
        });
        console.log(`[LIVE-CRON] Derived matchSchedule from fixturesCache: ${fixturesDoc.fixtures.length} matches`);
      } else if (fixturesDoc && (!fixturesDoc.fixtures || fixturesDoc.fixtures.length === 0)) {
        // Cache exists but empty — no fixtures today
        schedule = { kickoffTimes: [], firstKickoff: null, lastExpectedEnd: null };
      }
      // If fixturesDoc is null (nothing cached yet), schedule stays null → proceed normally
    }

    if (schedule) {
      // CRITICAL: Convert all timestamps with Number() — Sanity may deserialize as strings
      const firstKickoff = schedule.firstKickoff ? Number(schedule.firstKickoff) : null;
      const lastExpectedEnd = schedule.lastExpectedEnd ? Number(schedule.lastExpectedEnd) : null;

      // No fixtures today
      if (!schedule.kickoffTimes || schedule.kickoffTimes.length === 0) {
        console.log('[LIVE-CRON]', { now, firstKickoff, lastExpectedEnd, skipped: true, reason: 'No fixtures scheduled today' });
        return Response.json({
          success: true,
          skipped: true,
          reason: 'No fixtures scheduled today',
          apiCalls: 0,
          timestamp: new Date().toISOString(),
        });
      }

      // Before first kickoff (5 min margin)
      if (firstKickoff && now < firstKickoff - 5 * 60 * 1000) {
        const reason = `Before first kickoff (${new Date(firstKickoff).toISOString()})`;
        console.log('[LIVE-CRON]', { now, firstKickoff, lastExpectedEnd, skipped: true, reason });
        return Response.json({
          success: true,
          skipped: true,
          reason,
          nextCheck: new Date(firstKickoff - 5 * 60 * 1000).toISOString(),
          apiCalls: 0,
          timestamp: new Date().toISOString(),
        });
      }

      // After last expected end (30 min tolerance for extra time / delays)
      if (lastExpectedEnd && now > lastExpectedEnd + 30 * 60 * 1000) {
        const reason = `After last expected end + 30min (${new Date(lastExpectedEnd).toISOString()})`;
        console.log('[LIVE-CRON]', { now, firstKickoff, lastExpectedEnd, skipped: true, reason });
        return Response.json({
          success: true,
          skipped: true,
          reason,
          apiCalls: 0,
          timestamp: new Date().toISOString(),
        });
      }

      // Within the day's window — check if any specific match is active or near
      const hasActiveMatch = schedule.kickoffTimes.some(m => {
        const kickoff = Number(m.kickoff);
        const expectedEnd = Number(m.expectedEnd);
        return now >= kickoff - 5 * 60 * 1000 && now <= expectedEnd;
      });

      if (!hasActiveMatch) {
        const reason = 'No active matches in window';
        console.log('[LIVE-CRON]', { now, firstKickoff, lastExpectedEnd, skipped: true, reason, matchCount: schedule.kickoffTimes.length });
        return Response.json({
          success: true,
          skipped: true,
          reason,
          apiCalls: 0,
          timestamp: new Date().toISOString(),
        });
      }

      console.log('[LIVE-CRON]', { now, firstKickoff, lastExpectedEnd, skipped: false, reason: 'Active matches found' });
    } else {
      console.log('[LIVE-CRON]', { now, skipped: false, reason: 'No schedule found — proceeding as fallback' });
    }

    const allLive = await apiFetch('/fixtures?live=all');
    let apiCalls = 1;

    if (!allLive) {
      return Response.json({ success: false, error: 'API fetch failed', timestamp: new Date().toISOString() });
    }

    const tracked = allLive.filter(m => ALL_LEAGUE_IDS.includes(m.league.id));

    // ── 1. Extract ALL live data from /fixtures?live=all response (0 extra API calls) ──
    // The live=all response already includes match.events[] and match.statistics[]
    // No per-match API calls needed — everything comes from the single call above
    const liveDetailsMap = {};

    for (const match of tracked) {
      const fid = match.fixture.id;
      const liveData = extractLiveStats(match, match.events || [], match.statistics || []);
      liveData.date = today;
      liveDetailsMap[fid] = liveData;

      // RULE: Only persist to Sanity if match is FINISHED
      if (FINISHED_STATUSES.includes(match.fixture.status.short)) {
        liveData.savedAt = new Date().toISOString();
        await saveToSanity('liveMatchStats', String(fid), liveData);
        await redisSet(KEYS.fixtureStats(fid), liveData, TTL.yesterday);
      }
    }

    // ── 1b. Save live data to Redis for instant dashboard access ──
    // Merge with existing live:{date} so FT matches aren't lost when they drop from the live feed
    const existingLive = await redisGet(KEYS.liveStats(today)) || {};
    // Preserve goalScorers/missedPenalties from existing if new data has none (API events are inconsistent)
    const mergedLive = { ...existingLive };
    for (const [fid, data] of Object.entries(liveDetailsMap)) {
      const existing = existingLive[fid];
      mergedLive[fid] = {
        ...data,
        goalScorers: data.goalScorers?.length > 0 ? data.goalScorers : (existing?.goalScorers || []),
        missedPenalties: data.missedPenalties?.length > 0 ? data.missedPenalties : (existing?.missedPenalties || []),
      };
    }
    // Save individual fixture stats to Redis
    if (Object.keys(liveDetailsMap).length > 0) {
      await Promise.all(
        Object.entries(liveDetailsMap).map(([fid, data]) =>
          redisSet(KEYS.fixtureStats(fid), data, TTL.fixtureStats)
        )
      );
    }
    // NOTE: mergedLive is saved AFTER stale detection so FT status + full stats
    // from finished matches are included in a single write to live:{date}

    // ── 2. Detect recently-finished matches (were live in cache, now dropped from live feed) ──
    const finishedUpdates = [];
    let staleFixedCount = 0;

    // Reuse fixturesDoc if already loaded during schedule derivation, otherwise load once
    let fixturesDoc = scheduleFixturesDoc || await getFromSanity('footballFixturesCache', today);
    if (fixturesDoc?.fixtures) {
      const LIVE_STATUSES = ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'];
      const currentLiveIds = new Set(tracked.map(m => m.fixture.id));

      // Use live:{date} Redis (existingLive) as source of truth for which matches were live —
      // footballFixturesCache stays at NS status from the daily cron and never reflects live state,
      // so stale detection based on it never fires. Redis is updated every minute by this cron.
      const staleIds = Object.entries(existingLive)
        .filter(([fid, m]) => LIVE_STATUSES.includes(m.status?.short) && !currentLiveIds.has(Number(fid)))
        .map(([fid]) => Number(fid));

      const staleMatches = staleIds
        .map(fid => fixturesDoc.fixtures.find(f => f.fixture.id === fid))
        .filter(Boolean);

      if (staleMatches.length > 0) {
        await Promise.all(staleMatches.map(async (stale) => {
          const fid = stale.fixture.id;
          const data = await apiFetch(`/fixtures?id=${fid}`);
          apiCalls++;
          if (data?.[0]) {
            const fresh = data[0];
            const freshStatus = fresh.fixture.status.short;

            if (FINISHED_STATUSES.includes(freshStatus)) {
              // Use events + statistics from the /fixtures?id={fid} response (0 extra calls)
              const fullStats = extractLiveStats(fresh, fresh.events || [], fresh.statistics || []);
              fullStats.date = today;
              fullStats.savedAt = new Date().toISOString();

              // Save PERMANENTLY to Sanity (historical record)
              await saveToSanity('liveMatchStats', String(fid), fullStats);
              // Save to Redis with 48h TTL for fast access
              await redisSet(KEYS.fixtureStats(fid), fullStats, TTL.yesterday);
              // Also update live:{date} so page reloads show FT status + real stats
              mergedLive[fid] = { ...fullStats, status: fresh.fixture.status };
              staleFixedCount++;

              // Include full stats in Pusher update
              finishedUpdates.push({
                fixtureId: fid,
                status: fresh.fixture.status,
                goals: fresh.goals,
                score: fresh.score,
                corners: fullStats.corners,
                yellowCards: fullStats.yellowCards,
                redCards: fullStats.redCards,
                goalScorers: fullStats.goalScorers || [],
                missedPenalties: fullStats.missedPenalties || [],
              });
            } else {
              // Not finished yet — push basic update
              finishedUpdates.push({
                fixtureId: fid,
                status: fresh.fixture.status,
                goals: fresh.goals,
                score: fresh.score,
              });
            }
          }
        }));
      }

      // ── 3. Update footballFixturesCache — ONLY for finished matches ──
      const finishedStatusMap = {};

      // From currently-tracked matches that just finished
      tracked.forEach(m => {
        if (FINISHED_STATUSES.includes(m.fixture.status.short)) {
          finishedStatusMap[m.fixture.id] = {
            status: m.fixture.status,
            goals: m.goals,
            score: m.score,
          };
        }
      });

      // From stale-detected matches that are now confirmed finished
      finishedUpdates.forEach(u => {
        if (FINISHED_STATUSES.includes(u.status.short)) {
          finishedStatusMap[u.fixtureId] = {
            status: u.status,
            goals: u.goals,
            score: u.score,
          };
        }
      });

      if (Object.keys(finishedStatusMap).length > 0) {
        const updatedFixtures = fixturesDoc.fixtures.map(f => {
          const u = finishedStatusMap[f.fixture.id];
          if (u) {
            return {
              ...f,
              fixture: { ...f.fixture, status: u.status },
              goals: u.goals || f.goals,
              score: u.score || f.score,
            };
          }
          return f;
        });
        await saveToSanity('footballFixturesCache', today, {
          ...fixturesDoc,
          fixtures: updatedFixtures,
        });
      }
    }

    // ── 3b. Save mergedLive to Redis — done here so FT status from stale detection is included ──
    if (Object.keys(mergedLive).length > 0) {
      await redisSet(KEYS.liveStats(today), mergedLive, TTL.liveStats);
    }

    // ── 4. Push real-time update via Pusher (ALL live data, never filtered) ──
    const allPusherUpdates = [];
    tracked.forEach(m => {
      const details = liveDetailsMap[m.fixture.id];
      allPusherUpdates.push({
        fixtureId: m.fixture.id,
        status: m.fixture.status,
        goals: m.goals,
        score: m.score,
        corners: details?.corners || null,
        yellowCards: details?.yellowCards || null,
        redCards: details?.redCards || null,
        goalScorers: details?.goalScorers || [],
        missedPenalties: details?.missedPenalties || [],
      });
    });
    // Include recently-finished matches so open dashboards update immediately
    allPusherUpdates.push(...finishedUpdates);

    if (allPusherUpdates.length > 0) {
      await triggerEvent('live-scores', 'update', {
        date: today,
        liveCount: tracked.length,
        matches: allPusherUpdates,
        timestamp: new Date().toISOString(),
      });
    }

    // Track API calls (atomic Redis INCR)
    for (let i = 0; i < apiCalls; i++) {
      await incrementApiCallCount();
    }

    return Response.json({
      success: true,
      liveCount: tracked.length,
      totalLive: allLive.length,
      staleFixed: staleFixedCount,
      apiCalls,
      updated: tracked.length > 0 || staleFixedCount > 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[LIVE] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
