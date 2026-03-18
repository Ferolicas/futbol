import { getFromSanity, saveToSanity } from '../../../../lib/sanity';
import { ALL_LEAGUE_IDS } from '../../../../lib/leagues';
import { triggerEvent } from '../../../../lib/pusher';

// Cron: runs every 1 minute during active hours
// cron-job.org: GET /api/cron/live?secret=CRON_SECRET

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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

async function fetchLiveScores() {
  const key = getApiKey();
  if (!key) return null;

  const res = await fetch(`https://${API_HOST}/fixtures?live=all`, {
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

export async function GET(request) {
  if (!verifyCronAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const today = new Date().toISOString().split('T')[0];

    const allLive = await fetchLiveScores();

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

      // Push real-time update via Pusher
      const liveUpdates = tracked.map(m => ({
        fixtureId: m.fixture.id,
        status: m.fixture.status,
        goals: m.goals,
        score: m.score,
      }));

      await triggerEvent('live-scores', 'update', {
        date: today,
        liveCount: tracked.length,
        matches: liveUpdates,
        timestamp: new Date().toISOString(),
      });
    }

    // Track API call
    const callDocId = `apiCalls-${today}`;
    const callDoc = await getFromSanity('appConfig', callDocId);
    const count = (callDoc?.count || 0) + 1;
    await saveToSanity('appConfig', callDocId, { date: today, count });

    return Response.json({
      success: true,
      liveCount: tracked.length,
      totalLive: allLive.length,
      updated: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[LIVE] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
