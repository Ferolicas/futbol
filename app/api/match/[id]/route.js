import { getQuota, refreshLineups, refreshInjuries } from '../../../../lib/api-football';
import { getCachedAnalysis, getCachedFixtures } from '../../../../lib/sanity-cache';
import { redisGet, KEYS } from '../../../../lib/redis';

export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const { id } = params;
  const { searchParams } = new URL(request.url);
  const clientDate = searchParams.get('date');

  if (!id) {
    return Response.json({ error: 'fixture id required' }, { status: 400 });
  }

  try {
    const analysis = await getCachedAnalysis(id, clientDate);

    if (!analysis) {
      return Response.json({ error: 'Match not analyzed yet', notFound: true }, { status: 404 });
    }

    // Merge latest live status from Redis (real-time, updated every minute by live cron).
    // The analysis was cached when status was NS, but the match may now be live or finished.
    const today = clientDate || new Date().toISOString().split('T')[0];
    let statusUpdated = false;

    // 1. Try Redis live:{date} first (most up-to-date, written every minute)
    try {
      const liveData = await redisGet(KEYS.liveStats(today));
      if (liveData && liveData[id]) {
        const live = liveData[id];
        if (live.status?.short && live.status.short !== analysis.status?.short) {
          analysis.status = live.status;
          analysis.goals = live.goals || analysis.goals;
          statusUpdated = true;
        }
      }
    } catch {}

    // 2. Try Redis stats:{fid} (persists 48h, catches finished matches after live:{date} expires)
    if (!statusUpdated) {
      try {
        const stats = await redisGet(KEYS.fixtureStats(id));
        if (stats?.status?.short && stats.status.short !== analysis.status?.short) {
          analysis.status = stats.status;
          analysis.goals = stats.goals || analysis.goals;
          statusUpdated = true;
        }
      } catch {}
    }

    // 3. Fallback to fixtures cache in Sanity (least fresh but covers edge cases)
    if (!statusUpdated && clientDate) {
      try {
        const fixtures = await getCachedFixtures(clientDate);
        if (fixtures) {
          const fresh = fixtures.find(f => f.fixture.id === Number(id));
          if (fresh) {
            const freshStatus = fresh.fixture?.status?.short;
            if (freshStatus && freshStatus !== analysis.status?.short) {
              analysis.status = fresh.fixture.status;
              analysis.goals = fresh.goals || analysis.goals;
            }
          }
        }
      } catch {}
    }

    const quota = await getQuota();
    return Response.json({ analysis, quota });
  } catch (error) {
    console.error('Match fetch error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// POST to refresh lineups or injuries
export async function POST(request, { params }) {
  const { id } = params;
  const { action } = await request.json();

  try {
    if (action === 'refresh-lineups') {
      const lineups = await refreshLineups(id);
      const quota = await getQuota();

      // Persist lineups into the analysis document so they show next time without refresh
      if (lineups.available) {
        const { saveToSanity, getFromSanity } = await import('../../../../lib/sanity');
        const existing = await getFromSanity('footballMatchAnalysis', String(id));
        if (existing) {
          await saveToSanity('footballMatchAnalysis', String(id), {
            ...existing,
            lineups,
          });
        }
      }

      return Response.json({ lineups, quota });
    }

    if (action === 'refresh-injuries') {
      const injuries = await refreshInjuries(id);
      const quota = await getQuota();
      return Response.json({ injuries, quota });
    }

    return Response.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('Match action error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
