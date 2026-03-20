import { ALL_LEAGUE_IDS } from '../../../lib/leagues';

export const dynamic = 'force-dynamic';

const API_HOST = 'v3.football.api-sports.io';

// In-memory cache: 30s TTL to prevent burning API quota
let _livePollCache = { data: null, timestamp: 0 };
const CACHE_TTL = 30_000;

export async function GET(request) {
  try {
    const key = process.env.FOOTBALL_API_KEY;
    if (!key) {
      return Response.json({ liveStats: [], error: 'No API key' });
    }

    const now = Date.now();

    // Return cached data if fresh
    if (_livePollCache.data && (now - _livePollCache.timestamp) < CACHE_TTL) {
      return Response.json({
        liveStats: _livePollCache.data,
        timestamp: new Date(_livePollCache.timestamp).toISOString(),
        source: 'memory-cache',
      }, {
        headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
      });
    }

    // Fetch live matches directly from API-Football
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

    const liveStats = tracked.map(m => ({
      fixtureId: m.fixture.id,
      status: m.fixture.status,
      goals: m.goals,
      score: m.score,
      homeTeam: { id: m.teams.home.id, name: m.teams.home.name },
      awayTeam: { id: m.teams.away.id, name: m.teams.away.name },
      updatedAt: new Date().toISOString(),
    }));

    // Update cache
    _livePollCache = { data: liveStats, timestamp: now };

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
