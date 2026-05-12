// @ts-nocheck
/**
 * Job: futbol-live-corners
 * Port of /api/cron/live-corners. Fetches /fixtures/statistics for currently
 * live matches to refresh corner counts. ~1 API call per live match.
 *
 * Payload: {}
 */
import { triggerEvent, redisGet, redisSet, KEYS, TTL, incrementApiCallCount } from '../../shared.js';

const API_HOST = 'v3.football.api-sports.io';
const LIVE_STATUSES = ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'];

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

export async function runLiveCorners(_payload = {}) {
  const today = new Date().toISOString().split('T')[0];

  const liveData = await redisGet(KEYS.liveStats(today));
  if (!liveData || typeof liveData !== 'object') {
    return { ok: true, skipped: true, reason: 'no live data in Redis', apiCalls: 0 };
  }

  const liveFixtureIds = Object.values(liveData)
    .filter(m => m.status?.short && LIVE_STATUSES.includes(m.status.short))
    .map(m => m.fixtureId)
    .filter(Boolean);

  if (liveFixtureIds.length === 0) {
    return { ok: true, skipped: true, reason: 'no active matches right now', apiCalls: 0 };
  }

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

    liveData[fid] = { ...existing, corners };
    pusherUpdates.push({ fixtureId: fid, corners });
  }));

  if (pusherUpdates.length > 0) {
    await redisSet(KEYS.liveStats(today), liveData, TTL.liveStats);
    await triggerEvent('live-scores', 'corners-update', {
      date: today, matches: pusherUpdates, timestamp: new Date().toISOString(),
    });
  }

  for (let i = 0; i < apiCalls; i++) await incrementApiCallCount();

  return { ok: true, checkedMatches: liveFixtureIds.length, updatedMatches: pusherUpdates.length, apiCalls };
}
