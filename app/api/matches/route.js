import { getMatches } from '../../../lib/football-api';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date');

  if (!date) {
    return Response.json({ error: 'date parameter required' }, { status: 400 });
  }

  try {
    const result = await getMatches(date);
    return Response.json(result);
  } catch (error) {
    console.error('Matches error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
