// @ts-nocheck
/**
 * Job: futbol-live-corners
 * Port of /api/cron/live-corners. Fetches /fixtures/statistics for currently
 * live matches to refresh corner counts. ~1 API call per live match.
 *
 * Schedule on cron-job.org: every 5 minutes (was 30). With the 150k/day plan
 * even 100 simultaneous matches × 18 polls/match = 1800 calls/day — trivial.
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

    // LC1 FIX: piso monótono por-lado (mismo criterio que live.js). El endpoint
    // dedicado a veces trae un lado en null → getVal lo daba como 0 y pisaba un
    // valor mayor ya guardado (ej. 8-3 → 8-0) → el córner "retrocedía" en pantalla.
    // Nunca bajar por debajo del último valor conocido.
    const prevC = existing?.corners || {};
    const hCorners = Math.max(getVal(homeStats, 'Corner Kicks'), prevC.home ?? 0);
    const aCorners = Math.max(getVal(awayStats, 'Corner Kicks'), prevC.away ?? 0);
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

  if (apiCalls > 0) await incrementApiCallCount(apiCalls); // NT7: 1 INCRBY en vez de N INCR

  return { ok: true, checkedMatches: liveFixtureIds.length, updatedMatches: pusherUpdates.length, apiCalls };
}
