import { getQuota, refreshLineups, refreshInjuries } from '../../../../lib/api-football';
import { getCachedAnalysis } from '../../../../lib/sanity-cache';

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
