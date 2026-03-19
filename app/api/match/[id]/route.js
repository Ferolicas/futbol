import { getQuota, refreshLineups, refreshInjuries } from '../../../../lib/api-football';
import { getCachedAnalysis, getCachedFixtures } from '../../../../lib/sanity-cache';

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

    // Merge latest fixture status/goals from fixtures cache to prevent stale data.
    // The analysis may have been cached when status was NS, but the match may now be FT.
    if (clientDate) {
      try {
        const fixtures = await getCachedFixtures(clientDate);
        if (fixtures) {
          const fresh = fixtures.find(f => f.fixture.id === Number(id));
          if (fresh) {
            const freshStatus = fresh.fixture?.status?.short;
            const cachedStatus = analysis.status?.short;
            // Update if the fixture has progressed (live/finished vs NS)
            if (freshStatus && freshStatus !== cachedStatus) {
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
