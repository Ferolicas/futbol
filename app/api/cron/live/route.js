import { getFromSanity, saveToSanity } from '../../../../lib/sanity';
import { ALL_LEAGUE_IDS } from '../../../../lib/leagues';
import { triggerEvent } from '../../../../lib/pusher';
import { redisGet, redisSet, KEYS, TTL } from '../../../../lib/redis';

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
  const hYellow = getVal(homeStats, 'Yellow Cards');
  const aYellow = getVal(awayStats, 'Yellow Cards');
  const hRed = getVal(homeStats, 'Red Cards');
  const aRed = getVal(awayStats, 'Red Cards');

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
    if (!schedule) {
      const fixturesDoc = await getFromSanity('footballFixturesCache', today);
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

    // ── 1. Build live data — throttle per-match API calls to every 5 minutes ──
    // Every minute: use /fixtures?live=all data for score/status (already fetched, 0 extra calls)
    // Every 5 minutes OR on FT: fetch events+stats for corners/cards/scorers
    const currentMinute = new Date().getMinutes();
    const isDetailedTick = currentMinute % 5 === 0;

    const liveDetailsMap = {};

    // Split: matches needing fresh events+stats vs those that can use cached data
    const needDetailedFetch = tracked.filter(m =>
      FINISHED_STATUSES.includes(m.fixture.status.short) || isDetailedTick
    );
    const useCachedMatches = tracked.filter(m =>
      !FINISHED_STATUSES.includes(m.fixture.status.short) && !isDetailedTick
    );

    // Build live data from Redis cache for non-detailed-tick matches (0 API calls)
    if (useCachedMatches.length > 0) {
      const cachedStats = await Promise.all(
        useCachedMatches.map(m => redisGet(KEYS.fixtureStats(m.fixture.id)))
      );
      useCachedMatches.forEach((match, i) => {
        const fid = match.fixture.id;
        const cached = cachedStats[i];
        liveDetailsMap[fid] = {
          fixtureId: fid,
          status: match.fixture.status,
          goals: match.goals,
          score: match.score,
          homeTeam: { id: match.teams.home.id, name: match.teams.home.name },
          awayTeam: { id: match.teams.away.id, name: match.teams.away.name },
          corners: cached?.corners || { home: 0, away: 0, total: 0 },
          yellowCards: cached?.yellowCards || { home: 0, away: 0, total: 0 },
          redCards: cached?.redCards || { home: 0, away: 0, total: 0 },
          goalScorers: cached?.goalScorers || [],
          cardEvents: cached?.cardEvents || [],
          missedPenalties: cached?.missedPenalties || [],
          updatedAt: new Date().toISOString(),
          date: today,
        };
      });
    }

    // Fetch full events+stats only for FT matches and every-5-min detailed ticks
    if (needDetailedFetch.length > 0) {
      await Promise.all(needDetailedFetch.map(async (match) => {
        const fid = match.fixture.id;
        const [eventsData, statsData] = await Promise.all([
          apiFetch(`/fixtures/events?fixture=${fid}`),
          apiFetch(`/fixtures/statistics?fixture=${fid}`),
        ]);
        apiCalls += 2;

        const liveData = extractLiveStats(match, eventsData, statsData);
        liveData.date = today;
        liveDetailsMap[fid] = liveData;

        // RULE: Only persist to Sanity if match is FINISHED
        if (FINISHED_STATUSES.includes(match.fixture.status.short)) {
          liveData.savedAt = new Date().toISOString();
          await saveToSanity('liveMatchStats', String(fid), liveData);
          // Also save to Redis with 48h TTL for fast retrieval
          await redisSet(KEYS.fixtureStats(fid), liveData, TTL.yesterday);
        }
      }));
    }

    // ── 1b. Save live data to Redis for instant dashboard access ──
    // Merge with existing live:{date} so FT matches aren't lost when they drop from the live feed
    const existingLive = await redisGet(KEYS.liveStats(today)) || {};
    const mergedLive = { ...existingLive, ...liveDetailsMap };
    if (Object.keys(mergedLive).length > 0) {
      await redisSet(KEYS.liveStats(today), mergedLive, TTL.liveStats);
    }
    // Save individual fixture stats (only for matches with fresh API data)
    if (needDetailedFetch.length > 0) {
      await Promise.all(
        needDetailedFetch
          .filter(m => liveDetailsMap[m.fixture.id])
          .map(m => redisSet(KEYS.fixtureStats(m.fixture.id), liveDetailsMap[m.fixture.id], TTL.fixtureStats))
      );
    }

    // ── 2. Detect recently-finished matches (were live in cache, now dropped from live feed) ──
    const finishedUpdates = [];
    let staleFixedCount = 0;

    const fixturesDoc = await getFromSanity('footballFixturesCache', today);
    if (fixturesDoc?.fixtures) {
      const LIVE_STATUSES = ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'];
      const currentLiveIds = new Set(tracked.map(m => m.fixture.id));

      // Matches that show live status in cache but are no longer in the live feed
      const staleMatches = fixturesDoc.fixtures.filter(f =>
        LIVE_STATUSES.includes(f.fixture?.status?.short) && !currentLiveIds.has(f.fixture.id)
      );

      if (staleMatches.length > 0) {
        await Promise.all(staleMatches.map(async (stale) => {
          const fid = stale.fixture.id;
          const data = await apiFetch(`/fixtures?id=${fid}`);
          apiCalls++;
          if (data?.[0]) {
            const fresh = data[0];
            const freshStatus = fresh.fixture.status.short;

            if (FINISHED_STATUSES.includes(freshStatus)) {
              // Fetch FULL stats (events + statistics) for the finished match
              const [eventsData, statsData] = await Promise.all([
                apiFetch(`/fixtures/events?fixture=${fid}`),
                apiFetch(`/fixtures/statistics?fixture=${fid}`),
              ]);
              apiCalls += 2;

              const fullStats = extractLiveStats(fresh, eventsData, statsData);
              fullStats.date = today;
              fullStats.savedAt = new Date().toISOString();

              // Save PERMANENTLY to Sanity (historical record)
              await saveToSanity('liveMatchStats', String(fid), fullStats);
              // Save to Redis with 48h TTL for fast access
              await redisSet(KEYS.fixtureStats(fid), fullStats, TTL.yesterday);
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

    // Track API calls
    const callDocId = `apiCalls-${today}`;
    const callDoc = await getFromSanity('appConfig', callDocId);
    const count = (callDoc?.count || 0) + apiCalls;
    await saveToSanity('appConfig', callDocId, { date: today, count });

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
