import { getFixtures, getQuota } from '../../../lib/api-football';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date');

  if (!date) {
    return Response.json({ error: 'date parameter required' }, { status: 400 });
  }

  try {
    const result = await getFixtures(date);
    const quota = await getQuota();
    return Response.json({
      matches: result.fixtures || [],
      fromCache: result.fromCache || false,
      quota,
    }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (error) {
    console.error('Matches error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
