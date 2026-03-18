import { getFromSanity, saveToSanity } from '../../../../lib/sanity';
import { ALL_LEAGUE_IDS } from '../../../../lib/leagues';
import { triggerEvent } from '../../../../lib/pusher';

// Cron: runs every 1 minute during active hours
// cron-job.org: GET /api/cron/live?secret=CRON_SECRET

export const dynamic = 'force-dynamic';
export const maxDuration = 55;

const API_HOST = 'v3.football.api-sports.io';

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

    if (tracked.length === 0) {
      return Response.json({
        success: true, liveCount: 0, updated: false,
        timestamp: new Date().toISOString(),
      });
    }

    // Fetch events and statistics for each tracked live match
    const liveDetailsMap = {};
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

      // Persist live stats to Sanity (survives after match ends)
      await saveToSanity('liveMatchStats', String(fid), liveData);
    }));

    // Update the cached matchDay document with live scores
    const cached = await getFromSanity('matchDay', today);
    if (cached?.matches) {
      const matches = cached.matches.map(m => {
        const liveMatch = tracked.find(l => l.fixture.id === m.fixture.id);
        if (liveMatch) {
          return {
            ...m,
            fixture: { ...m.fixture, status: liveMatch.fixture.status },
            goals: liveMatch.goals,
            score: liveMatch.score,
          };
        }
        return m;
      });

      await saveToSanity('matchDay', today, {
        ...cached,
        matches,
        liveUpdatedAt: new Date().toISOString(),
      });
    }

    // Push real-time update via Pusher (compact payload for 10KB limit)
    const liveUpdates = tracked.map(m => {
      const details = liveDetailsMap[m.fixture.id];
      return {
        fixtureId: m.fixture.id,
        status: m.fixture.status,
        goals: m.goals,
        score: m.score,
        corners: details?.corners || null,
        yellowCards: details?.yellowCards || null,
        redCards: details?.redCards || null,
        goalScorers: details?.goalScorers || [],
        missedPenalties: details?.missedPenalties || [],
      };
    });

    await triggerEvent('live-scores', 'update', {
      date: today,
      liveCount: tracked.length,
      matches: liveUpdates,
      timestamp: new Date().toISOString(),
    });

    // Track API calls
    const callDocId = `apiCalls-${today}`;
    const callDoc = await getFromSanity('appConfig', callDocId);
    const count = (callDoc?.count || 0) + apiCalls;
    await saveToSanity('appConfig', callDocId, { date: today, count });

    return Response.json({
      success: true,
      liveCount: tracked.length,
      totalLive: allLive.length,
      apiCalls,
      updated: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[LIVE] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
