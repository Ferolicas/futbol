import { getMatches, getAvailableApiKey } from '../../../lib/football-api';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date');

  if (!date) {
    return Response.json({ error: 'date parameter required' }, { status: 400 });
  }

  const keyInfo = await getAvailableApiKey();
  if (!keyInfo) {
    return Response.json({ error: 'No API keys available or all quota exhausted' }, { status: 500 });
  }

  try {
    const result = await getMatches(date, keyInfo);
    return Response.json(result);
  } catch (error) {
    console.error('Matches error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
