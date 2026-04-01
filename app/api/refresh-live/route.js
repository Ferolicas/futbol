import { redisGet, redisSet, KEYS, TTL } from '../../../lib/redis';
import { ALL_LEAGUE_IDS } from '../../../lib/leagues';

// Force-refresh live data — direct API call, no cron chaining.
// Rate-limited to once every 15s via Redis lock.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const LOCK_KEY = 'refresh-live:lock';
const LOCK_TTL = 15;
const API_HOST = 'v3.football.api-sports.io';

const YOUTH_RE = /\bU-?1[2-9]\b|\bU-?2[0-3]\b|\bunder[ -]?(1[2-9]|2[0-3])\b|\byouth\b|\bjunior\b|\bsub-?(1[2-9]|2[0-3])\b/i;

function extractStats(match) {
  const homeId = match.teams.home.id;
  const awayId = match.teams.away.id;
  const homeStats = (match.statistics || []).find(s => s.team?.id === homeId);
  const awayStats = (match.statistics || []).find(s => s.team?.id === awayId);

  const getStat = (statsObj, name) => {
    if (!statsObj?.statistics) return null;
    const s = statsObj.statistics.find(x => x.type === name);
    return s?.value ?? null;
  };

  return {
    fixtureId: match.fixture.id,
    status: match.fixture.status,
    goals: match.goals,
    score: match.score,
    elapsed: match.fixture.status.elapsed,
    teams: {
      home: { id: match.teams.home.id, name: match.teams.home.name, logo: match.teams.home.logo, winner: match.teams.home.winner },
      away: { id: match.teams.away.id, name: match.teams.away.name, logo: match.teams.away.logo, winner: match.teams.away.winner },
    },
    league: { id: match.league.id, name: match.league.name },
    events: (match.events || []).filter(e => ['Goal', 'Card', 'subst'].includes(e.type)),
    stats: {
      home: {
        corners: getStat(homeStats, 'Corner Kicks'),
        yellowCards: getStat(homeStats, 'Yellow Cards'),
        redCards: getStat(homeStats, 'Red Cards'),
        shots: getStat(homeStats, 'Total Shots'),
        shotsOnTarget: getStat(homeStats, 'Shots on Goal'),
        possession: getStat(homeStats, 'Ball Possession'),
      },
      away: {
        corners: getStat(awayStats, 'Corner Kicks'),
        yellowCards: getStat(awayStats, 'Yellow Cards'),
        redCards: getStat(awayStats, 'Red Cards'),
        shots: getStat(awayStats, 'Total Shots'),
        shotsOnTarget: getStat(awayStats, 'Shots on Goal'),
        possession: getStat(awayStats, 'Ball Possession'),
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

export async function POST(request) {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Rate limit — return cached data immediately if locked
    const lock = await redisGet(LOCK_KEY);
    if (lock) {
      const liveData = await redisGet(KEYS.liveStats(today));
      return Response.json({
        success: true,
        skipped: true,
        reason: 'Rate limited — returning cached data',
        liveStats: liveData && typeof liveData === 'object' ? liveData : {},
        timestamp: new Date().toISOString(),
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    await redisSet(LOCK_KEY, '1', LOCK_TTL);

    const apiKey = process.env.FOOTBALL_API_KEY;
    if (!apiKey) {
      console.error('[REFRESH-LIVE] FOOTBALL_API_KEY is not set');
      return Response.json({ success: false, error: 'No API key configured' }, { status: 500 });
    }

    // Single direct call — no cron chaining, no internal fetch
    const res = await fetch(`https://${API_HOST}/fixtures?live=all`, {
      headers: { 'x-apisports-key': apiKey },
      cache: 'no-store',
    });

    if (!res.ok) {
      console.error('[REFRESH-LIVE] API error:', res.status);
      const cached = await redisGet(KEYS.liveStats(today));
      return Response.json({
        success: false,
        error: `API returned ${res.status}`,
        liveStats: cached && typeof cached === 'object' ? cached : {},
        timestamp: new Date().toISOString(),
      });
    }

    const json = await res.json();
    if (json.errors && Object.keys(json.errors).length > 0) {
      console.error('[REFRESH-LIVE] API errors:', json.errors);
    }

    const tracked = (json.response || []).filter(m =>
      ALL_LEAGUE_IDS.includes(m.league.id) && !YOUTH_RE.test(m.league.name || '')
    );

    const liveStats = {};
    for (const match of tracked) {
      const fid = match.fixture.id;
      const stats = extractStats(match);
      stats.date = today;
      liveStats[fid] = stats;
      await redisSet(KEYS.fixtureStats(fid), stats, TTL.live);
    }

    await redisSet(KEYS.liveStats(today), liveStats, TTL.live);

    return Response.json({
      success: true,
      liveCount: tracked.length,
      liveStats,
      apiCalls: 1,
      timestamp: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });

  } catch (error) {
    console.error('[REFRESH-LIVE] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
