import { getQuota } from '../../../lib/api-football';

// Live state: ALWAYS fetches directly from API-Football.
// NEVER reads from Sanity cache — live state must be real-time.
// Uses in-memory cache (30s TTL) to prevent burning API quota on concurrent requests.

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const API_HOST = 'v3.football.api-sports.io';

// In-memory cache: survives across requests in the same serverless instance
// TTL = 30 seconds — ensures data is max 30s old
let _liveCache = { data: null, fetchedAt: 0 };
const CACHE_TTL = 30_000; // 30 seconds

function getApiKey() {
  return process.env.FOOTBALL_API_KEY;
}

async function fetchLiveFromApi() {
  const key = getApiKey();
  if (!key) return null;

  const res = await fetch(`https://${API_HOST}/fixtures?live=all`, {
    headers: { 'x-apisports-key': key },
    cache: 'no-store',
  });

  if (!res.ok) return null;
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    console.error('[LIVE] API error:', data.errors);
    return null;
  }
  return data.response || [];
}

async function fetchByDateFromApi(date) {
  const key = getApiKey();
  if (!key) return null;

  const res = await fetch(`https://${API_HOST}/fixtures?date=${date}`, {
    headers: { 'x-apisports-key': key },
    cache: 'no-store',
  });

  if (!res.ok) return null;
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    console.error('[LIVE] API error:', data.errors);
    return null;
  }
  return data.response || [];
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date');

  if (!date) {
    return Response.json({ error: 'date parameter required' }, { status: 400 });
  }

  try {
    const { ALL_LEAGUE_IDS, LEAGUES } = await import('../../../lib/leagues');
    const now = Date.now();

    // Check in-memory cache (30s TTL)
    if (_liveCache.data && (now - _liveCache.fetchedAt) < CACHE_TTL) {
      const filtered = _liveCache.data
        .filter(m => ALL_LEAGUE_IDS.includes(m.league.id));

      return Response.json({
        matches: filtered,
        allCount: filtered.length,
        source: 'api-football-memory-cache',
        cacheAgeSec: Math.round((now - _liveCache.fetchedAt) / 1000),
        updatedAt: new Date(_liveCache.fetchedAt).toISOString(),
      }, {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
      });
    }

    // Call API-Football directly — no Sanity, no cache
    const allFixtures = await fetchByDateFromApi(date);

    if (allFixtures && allFixtures.length > 0) {
      // Update in-memory cache
      _liveCache = { data: allFixtures, fetchedAt: now };

      const filtered = allFixtures
        .filter(m => ALL_LEAGUE_IDS.includes(m.league.id))
        .map(m => ({
          ...m,
          leagueMeta: LEAGUES[m.league.id] || { country: m.league.country, name: m.league.name, division: 0, gender: 'M' },
        }));

      return Response.json({
        matches: filtered,
        allCount: filtered.length,
        source: 'api-football',
        updatedAt: new Date().toISOString(),
      }, {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
      });
    }

    // API call failed — return empty, never stale data
    return Response.json({
      matches: [],
      allCount: 0,
      source: 'api-failed',
      error: 'Could not fetch live data from API',
    }, {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[LIVE] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
