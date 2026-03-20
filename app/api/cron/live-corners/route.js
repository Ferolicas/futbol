import { triggerEvent } from '../../../../lib/pusher';
import { redisGet, redisSet, KEYS, TTL } from '../../../../lib/redis';
import { incrementApiCallCount } from '../../../../lib/sanity-cache';

// Cron: runs every 45 minutes
// Fetches statistics (corners) for all currently-live matches
// ~2 calls per match over its 90-min duration → 180 calls for 90 matches/day
//
// cron-job.org: GET /api/cron/live-corners?secret=CRON_SECRET

export const dynamic = 'force-dynamic';
export const maxDuration = 55;

const API_HOST = 'v3.football.api-sports.io';
const LIVE_STATUSES = ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'];

function verifyCronAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret')
    || request.headers.get('authorization')?.replace('Bearer ', '');
  return secret === process.env.CRON_SECRET || process.env.NODE_ENV !== 'production';
}

async function apiFetch(endpoint) {
  const key = process.env.FOOTBALL_API_KEY;
  if (!key) return null;
  const res = await fetch(`https://${API_HOST}${endpoint}`, {
    headers: { 'x-apisports-key': key },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) return null;
  return data.response || [];
}

export async function GET(request) {
  if (!verifyCronAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = new Date().toISOString().split('T')[0];

  // Load current live data from Redis — tells us which matches are in play
  const liveData = await redisGet(KEYS.liveStats(today));
  if (!liveData || typeof liveData !== 'object') {
    return Response.json({ success: true, skipped: true, reason: 'No live data in Redis', apiCalls: 0 });
  }

  // Only matches currently live (not finished)
  const liveFixtureIds = Object.values(liveData)
    .filter(m => m.status?.short && LIVE_STATUSES.includes(m.status.short))
    .map(m => m.fixtureId)
    .filter(Boolean);

  if (liveFixtureIds.length === 0) {
    return Response.json({ success: true, skipped: true, reason: 'No active matches right now', apiCalls: 0 });
  }

  // Fetch statistics for each live match (1 call per match)
  let apiCalls = 0;
  const pusherUpdates = [];

  await Promise.all(liveFixtureIds.map(async (fid) => {
    const stats = await apiFetch(`/fixtures/statistics?fixture=${fid}`);
    apiCalls++;

    if (!stats || stats.length === 0) return;

    const getVal = (teamStats, type) => {
      const stat = (teamStats?.statistics || []).find(s => s.type === type);
      return stat?.value ?? 0;
    };

    const existing = liveData[fid];
    const homeId = existing?.homeTeam?.id;
    const awayId = existing?.awayTeam?.id;

    const homeStats = stats.find(s => s.team?.id === homeId);
    const awayStats = stats.find(s => s.team?.id === awayId);

    const hCorners = getVal(homeStats, 'Corner Kicks');
    const aCorners = getVal(awayStats, 'Corner Kicks');
    const corners = { home: hCorners, away: aCorners, total: hCorners + aCorners };

    // Only update if we actually got corner data
    if (hCorners === 0 && aCorners === 0) return;

    // Update live:{date} in place
    liveData[fid] = { ...existing, corners };

    pusherUpdates.push({ fixtureId: fid, corners });
  }));

  // Persist updated live data back to Redis
  if (pusherUpdates.length > 0) {
    await redisSet(KEYS.liveStats(today), liveData, TTL.liveStats);

    // Push corners update to all open dashboards
    await triggerEvent('live-scores', 'corners-update', {
      date: today,
      matches: pusherUpdates,
      timestamp: new Date().toISOString(),
    });
  }

  for (let i = 0; i < apiCalls; i++) {
    await incrementApiCallCount();
  }

  return Response.json({
    success: true,
    checkedMatches: liveFixtureIds.length,
    updatedMatches: pusherUpdates.length,
    apiCalls,
    timestamp: new Date().toISOString(),
  });
}
