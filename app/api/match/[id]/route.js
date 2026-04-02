import { getQuota, refreshLineups, refreshInjuries, fetchMatchStats } from '../../../../lib/api-football';
import { getCachedAnalysis, cacheAnalysis, getCachedFixtures } from '../../../../lib/sanity-cache';
import { redisGet, redisSet, KEYS, TTL } from '../../../../lib/redis';

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

    // Merge latest live status from Redis
    const today = clientDate || new Date().toISOString().split('T')[0];
    let statusUpdated = false;

    try {
      const liveData = await redisGet(KEYS.liveStats(today));
      if (liveData?.[id]) {
        const live = liveData[id];
        if (live.status?.short && live.status.short !== analysis.status?.short) {
          analysis.status = live.status;
          analysis.goals = live.goals || analysis.goals;
          statusUpdated = true;
        }
      }
    } catch {}

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

    if (!statusUpdated && clientDate) {
      try {
        const fixtures = await getCachedFixtures(clientDate);
        if (fixtures) {
          const fresh = fixtures.find(f => f.fixture.id === Number(id));
          if (fresh?.fixture?.status?.short && fresh.fixture.status.short !== analysis.status?.short) {
            analysis.status = fresh.fixture.status;
            analysis.goals = fresh.goals || analysis.goals;
          }
        }
      } catch {}
    }

    const quota = await getQuota();
    return Response.json({ analysis, quota });
  } catch (error) {
    console.error('[match:GET]', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// POST: refresh lineups or injuries
export async function POST(request, { params }) {
  const { id } = params;
  const { action, date } = await request.json();

  try {
    if (action === 'refresh-lineups') {
      const lineups = await refreshLineups(id);
      const quota = await getQuota();

      // Persist lineups into the cached analysis
      if (lineups.available) {
        const existing = await getCachedAnalysis(id, date);
        if (existing) {
          await cacheAnalysis(id, { ...existing, lineups });
        }
      }

      return Response.json({ lineups, quota });
    }

    if (action === 'refresh-injuries') {
      const injuries = await refreshInjuries(id);
      const quota = await getQuota();
      return Response.json({ injuries, quota });
    }

    if (action === 'refresh-stats') {
      // Check Redis first — only call API if truly missing
      const cached = await redisGet(KEYS.fixtureStats(id));
      const hasStats = cached && (
        (cached.corners?.total > 0) ||
        (cached.yellowCards?.total > 0) ||
        (cached.goalScorers?.length > 0) ||
        (cached.cardEvents?.length > 0)
      );
      if (hasStats) {
        return Response.json({ stats: cached, fromCache: true });
      }

      const stats = await fetchMatchStats(id);
      if (!stats) return Response.json({ error: 'Match not found' }, { status: 404 });

      await redisSet(KEYS.fixtureStats(id), stats, TTL.yesterday);
      const quota = await getQuota();
      return Response.json({ stats, quota });
    }

    return Response.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('[match:POST]', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
