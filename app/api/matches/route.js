import { getMatches } from '../../../lib/football-api';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date');
  const apiKey = process.env.FOOTBALL_API_KEY;

  if (!date) {
    return Response.json({ error: 'date parameter required' }, { status: 400 });
  }
  if (!apiKey) {
    return Response.json({ error: 'FOOTBALL_API_KEY not configured' }, { status: 500 });
  }

  try {
    const result = await getMatches(date, apiKey);
    return Response.json(result);
  } catch (error) {
    console.error('Matches error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
