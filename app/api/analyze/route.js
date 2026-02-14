import { analyzeMatch } from '../../../lib/football-api';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const fixtureId = searchParams.get('fixtureId');
  const homeId = searchParams.get('homeId');
  const awayId = searchParams.get('awayId');
  const leagueId = searchParams.get('leagueId');
  const season = searchParams.get('season');
  const date = searchParams.get('date');
  const apiKey = process.env.FOOTBALL_API_KEY;

  if (!fixtureId || !homeId || !awayId || !leagueId) {
    return Response.json({ error: 'Missing required parameters: fixtureId, homeId, awayId, leagueId' }, { status: 400 });
  }
  if (!apiKey) {
    return Response.json({ error: 'FOOTBALL_API_KEY not configured' }, { status: 500 });
  }

  try {
    const result = await analyzeMatch(
      Number(fixtureId),
      Number(homeId),
      Number(awayId),
      Number(leagueId),
      season ? Number(season) : null,
      date,
      apiKey
    );
    return Response.json(result);
  } catch (error) {
    console.error('Analyze error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
