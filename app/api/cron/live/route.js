import { getFromSanity, saveToSanity } from '../../../../lib/sanity';
import { ALL_LEAGUE_IDS } from '../../../../lib/leagues';
import { triggerEvent } from '../../../../lib/pusher';

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
    const allLive = await apiFetch('/fixtures?live=all');
    let apiCalls = 1;

    if (!allLive) {
      return Response.json({ success: false, error: 'API fetch failed', timestamp: new Date().toISOString() });
    }

    const tracked = allLive.filter(m => ALL_LEAGUE_IDS.includes(m.league.id));

    // ── 1. Fetch events & stats for currently-live matches ──
    const liveDetailsMap = {};
    if (tracked.length > 0) {
      await Promise.all(tracked.map(async (match) => {
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
          await saveToSanity('liveMatchStats', String(fid), liveData);
        }
      }));
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
          const data = await apiFetch(`/fixtures?id=${stale.fixture.id}`);
          apiCalls++;
          if (data?.[0]) {
            const fresh = data[0];
            const freshStatus = fresh.fixture.status.short;

            // Only persist if the match is now truly finished
            if (FINISHED_STATUSES.includes(freshStatus)) {
              const finalStats = {
                fixtureId: stale.fixture.id,
                date: today,
                status: fresh.fixture.status,
                goals: fresh.goals,
                score: fresh.score,
                updatedAt: new Date().toISOString(),
              };
              await saveToSanity('liveMatchStats', String(stale.fixture.id), finalStats);
              staleFixedCount++;
            }

            // Push update via Pusher regardless (client needs to know)
            finishedUpdates.push({
              fixtureId: stale.fixture.id,
              status: fresh.fixture.status,
              goals: fresh.goals,
              score: fresh.score,
            });
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
