import { ALL_LEAGUE_IDS } from '../../../lib/leagues';

export const dynamic = 'force-dynamic';

const API_HOST = 'v3.football.api-sports.io';

export async function GET(request) {
  try {
    const key = process.env.FOOTBALL_API_KEY;
    if (!key) {
      return Response.json({ liveStats: [], error: 'No API key' });
    }

    // Fetch live matches directly from API-Football — never from Sanity
    const res = await fetch(`https://${API_HOST}/fixtures?live=all`, {
      headers: { 'x-apisports-key': key },
      cache: 'no-store',
    });

    if (!res.ok) {
      return Response.json({ liveStats: [], error: `API error: ${res.status}` });
    }

    const data = await res.json();
    if (data.errors && Object.keys(data.errors).length > 0) {
      return Response.json({ liveStats: [], error: 'API-Football error' });
    }

    const allLive = data.response || [];
    const tracked = allLive.filter(m => ALL_LEAGUE_IDS.includes(m.league.id));

    // Map to the same shape the client expects
    const liveStats = tracked.map(m => ({
      fixtureId: m.fixture.id,
      status: m.fixture.status,
      goals: m.goals,
      score: m.score,
      homeTeam: { id: m.teams.home.id, name: m.teams.home.name },
      awayTeam: { id: m.teams.away.id, name: m.teams.away.name },
      updatedAt: new Date().toISOString(),
    }));

    return Response.json({
      liveStats,
      timestamp: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (error) {
    return Response.json({ liveStats: [], error: error.message });
  }
}
