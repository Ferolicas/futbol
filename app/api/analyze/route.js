import { analyzeMatch } from '../../../lib/football-api';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Single match analysis
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
    return Response.json({ error: 'Missing required parameters' }, { status: 400 });
  }
  if (!apiKey) {
    return Response.json({ error: 'FOOTBALL_API_KEY not configured' }, { status: 500 });
  }

  try {
    const result = await analyzeMatch(
      Number(fixtureId), Number(homeId), Number(awayId),
      Number(leagueId), season ? Number(season) : null, date, apiKey
    );
    return Response.json(result);
  } catch (error) {
    console.error('Analyze error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// Batch analysis - multiple matches at once
export async function POST(request) {
  const apiKey = process.env.FOOTBALL_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'FOOTBALL_API_KEY not configured' }, { status: 500 });
  }

  try {
    const { matches } = await request.json();
    if (!matches || !Array.isArray(matches) || matches.length === 0) {
      return Response.json({ error: 'matches array required' }, { status: 400 });
    }

    const results = {};
    let totalApiCalls = 0;

    // Process sequentially to avoid rate limiting
    for (const m of matches) {
      try {
        const result = await analyzeMatch(
          Number(m.fixtureId), Number(m.homeId), Number(m.awayId),
          Number(m.leagueId), m.season ? Number(m.season) : null, m.date, apiKey
        );
        results[m.fixtureId] = result.analysis;
        totalApiCalls += result.apiCalls || 0;
      } catch (e) {
        results[m.fixtureId] = { error: e.message };
      }
    }

    return Response.json({ results, apiCalls: totalApiCalls });
  } catch (error) {
    console.error('Batch analyze error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
