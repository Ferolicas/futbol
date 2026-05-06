// Baseball API client — api-sports.io v1
// Same API key as football (FOOTBALL_API_KEY). Quota: 100 calls/day for baseball.
//
// Strategy: extreme cache-first. Each call is precious.
//   - Fixtures: 1 call/day per date (cron at 03:00 Spain)
//   - Odds: 1 call/day per fixture, 6h before kickoff
//   - Live: 1 call/min only while at least one game is in progress
//   - Standings: 1 call/week per league
//   - Teams stats: 1 call/team per season (cached forever within season)

import {
  BASEBALL_LEAGUE_IDS,
  BASEBALL_LEAGUES,
  currentBaseballSeason,
  getBaseballLeagueMeta,
} from './baseball-leagues';
import { redisGet, redisSet } from './redis';
import { supabaseAdmin } from './supabase';

const API_HOST = 'v1.baseball.api-sports.io';
const DAILY_QUOTA = 100;

function getApiKey() {
  return process.env.FOOTBALL_API_KEY
    || process.env.BASEBALL_API_KEY
    || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY
    || null;
}

// ===================== RATE LIMITER =====================
// Mucho más conservador que el de fútbol porque solo hay 100 calls/día.
// Throttle a 1 req cada 600ms (≈100/min teóricos, pero gastamos pocas).
const MIN_DELAY_MS = 600;
let _throttleChain = Promise.resolve();
let _activeRequests = 0;
const MAX_CONCURRENT = 3;
const _queue = [];

function _scheduleNext() {
  while (_queue.length > 0 && _activeRequests < MAX_CONCURRENT) {
    const { resolve } = _queue.shift();
    _activeRequests++;
    resolve();
  }
}
function _acquireSlot() {
  if (_activeRequests < MAX_CONCURRENT) {
    _activeRequests++;
    return Promise.resolve();
  }
  return new Promise(r => _queue.push({ resolve: r }));
}
function _releaseSlot() {
  _activeRequests = Math.max(0, _activeRequests - 1);
  _scheduleNext();
}
function _throttle() {
  const myTurn = _throttleChain.then(() => new Promise(r => setTimeout(r, MIN_DELAY_MS)));
  _throttleChain = myTurn;
  return myTurn;
}

// ===================== QUOTA TRACKING =====================
// Counts daily calls in Supabase (separate row per date).
async function incrementBaseballCalls() {
  const today = new Date().toISOString().split('T')[0];
  try {
    const { data: existing } = await supabaseAdmin
      .from('baseball_api_calls')
      .select('count')
      .eq('date', today)
      .maybeSingle();

    const next = (existing?.count || 0) + 1;
    await supabaseAdmin
      .from('baseball_api_calls')
      .upsert({ date: today, count: next, updated_at: new Date().toISOString() });
    return next;
  } catch (e) {
    console.error('[api-baseball:quota]', e.message);
    return null;
  }
}

export async function getBaseballQuota() {
  const today = new Date().toISOString().split('T')[0];
  try {
    const { data } = await supabaseAdmin
      .from('baseball_api_calls')
      .select('count')
      .eq('date', today)
      .maybeSingle();
    const used = data?.count || 0;
    return { used, limit: DAILY_QUOTA, remaining: Math.max(0, DAILY_QUOTA - used), date: today };
  } catch {
    return { used: 0, limit: DAILY_QUOTA, remaining: DAILY_QUOTA, date: today };
  }
}

// ===================== CORE CALL =====================
async function apiCall(endpoint) {
  const key = getApiKey();
  if (!key) throw new Error('No API key configured (FOOTBALL_API_KEY)');

  // Hard cap: refuse to call API if quota exhausted (avoids hitting hard limits).
  const quota = await getBaseballQuota();
  if (quota.used >= DAILY_QUOTA) {
    throw new Error(`BASEBALL_QUOTA_EXHAUSTED:${quota.used}/${DAILY_QUOTA}`);
  }

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await _acquireSlot();
    let released = false;
    const release = () => { if (!released) { released = true; _releaseSlot(); } };

    try {
      await _throttle();
      const res = await fetch(`https://${API_HOST}${endpoint}`, {
        headers: { 'x-apisports-key': key },
        cache: 'no-store',
      });

      if (!res.ok) {
        if (res.status === 429) {
          release();
          if (attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
            continue;
          }
          throw new Error('RATE_LIMIT');
        }
        release();
        throw new Error(`API error: ${res.status}`);
      }

      const data = await res.json();
      if (data.errors && Object.keys(data.errors).length > 0) {
        const msg = Object.values(data.errors).join('; ');
        if (msg.toLowerCase().includes('rate') || msg.toLowerCase().includes('limit')) {
          release();
          if (attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
            continue;
          }
          throw new Error('RATE_LIMIT');
        }
        release();
        throw new Error(`API: ${msg}`);
      }

      await incrementBaseballCalls();
      release();
      return { response: data.response || [], remaining: res.headers.get('x-ratelimit-requests-remaining') };
    } catch (e) {
      release();
      if (e.message === 'RATE_LIMIT' && attempt < MAX_RETRIES) continue;
      throw e;
    }
  }
}

// ===================== FIXTURES =====================
// Daily fixtures across all configured leagues.
// Single endpoint call (1 cost) returning all games of the date.
export async function getBaseballFixturesByDate(date, { forceApi = false } = {}) {
  // Layer 1: Redis
  if (!forceApi) {
    const redisKey = `baseball:fixtures:${date}`;
    const cached = await redisGet(redisKey);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      return { fixtures: cached, fromCache: true, source: 'redis' };
    }
  }

  // Layer 2: Supabase
  if (!forceApi) {
    const { data } = await supabaseAdmin
      .from('baseball_fixtures_cache')
      .select('fixtures, fetched_at')
      .eq('date', date)
      .maybeSingle();
    if (data?.fixtures && Array.isArray(data.fixtures) && data.fixtures.length > 0) {
      await redisSet(`baseball:fixtures:${date}`, data.fixtures, 3600);
      return { fixtures: data.fixtures, fromCache: true, source: 'supabase' };
    }
  }

  // Layer 3: API
  const { response } = await apiCall(`/games?date=${date}`);
  const filtered = (response || [])
    .filter(g => BASEBALL_LEAGUE_IDS.includes(g.league?.id))
    .map(g => ({
      ...g,
      leagueMeta: getBaseballLeagueMeta(g.league?.id) || {
        country: g.country?.name,
        name: g.league?.name,
        division: 0,
      },
    }));

  if (filtered.length > 0) {
    await supabaseAdmin
      .from('baseball_fixtures_cache')
      .upsert({ date, fixtures: filtered, fetched_at: new Date().toISOString() });
    await redisSet(`baseball:fixtures:${date}`, filtered, 3600);
  }

  return { fixtures: filtered, fromCache: false, source: 'api' };
}

// ===================== GAME DETAIL =====================
export async function getBaseballGameById(fixtureId, { forceApi = false } = {}) {
  if (!forceApi) {
    const cached = await redisGet(`baseball:game:${fixtureId}`);
    if (cached) return { game: cached, fromCache: true };
  }
  const { response } = await apiCall(`/games?id=${fixtureId}`);
  const game = response?.[0] || null;
  if (game) await redisSet(`baseball:game:${fixtureId}`, game, 600);
  return { game, fromCache: false };
}

// ===================== ODDS =====================
// Baseball odds endpoint returns multi-bookmaker odds. We cache aggressively.
export async function getBaseballOddsByGame(fixtureId, { forceApi = false } = {}) {
  const redisKey = `baseball:odds:${fixtureId}`;
  if (!forceApi) {
    const cached = await redisGet(redisKey);
    if (cached) return { odds: cached, fromCache: true };
  }
  const { response } = await apiCall(`/odds?game=${fixtureId}`);
  const odds = response || [];
  if (odds.length > 0) await redisSet(redisKey, odds, 6 * 3600); // 6h
  return { odds, fromCache: false };
}

// ===================== STANDINGS =====================
export async function getBaseballStandings(leagueId, { forceApi = false } = {}) {
  const season = currentBaseballSeason(leagueId);
  const redisKey = `baseball:standings:${leagueId}:${season}`;

  if (!forceApi) {
    const cached = await redisGet(redisKey);
    if (cached) return { standings: cached, fromCache: true };

    const { data } = await supabaseAdmin
      .from('baseball_standings_cache')
      .select('standings, fetched_at')
      .eq('league_id', leagueId)
      .eq('season', season)
      .maybeSingle();
    if (data?.standings) {
      await redisSet(redisKey, data.standings, 24 * 3600);
      return { standings: data.standings, fromCache: true };
    }
  }

  const { response } = await apiCall(`/standings?league=${leagueId}&season=${season}`);
  const standings = response || [];
  if (standings.length > 0) {
    await supabaseAdmin
      .from('baseball_standings_cache')
      .upsert({ league_id: leagueId, season, standings, fetched_at: new Date().toISOString() });
    await redisSet(redisKey, standings, 7 * 24 * 3600); // 1 week
  }
  return { standings, fromCache: false };
}

// ===================== TEAM STATISTICS =====================
export async function getBaseballTeamStats(teamId, leagueId) {
  const season = currentBaseballSeason(leagueId);
  const redisKey = `baseball:team-stats:${teamId}:${leagueId}:${season}`;
  const cached = await redisGet(redisKey);
  if (cached) return { stats: cached, fromCache: true };

  const { response } = await apiCall(`/teams/statistics?league=${leagueId}&season=${season}&team=${teamId}`);
  const stats = response || null;
  if (stats) await redisSet(redisKey, stats, 24 * 3600);
  return { stats, fromCache: false };
}

// ===================== H2H =====================
export async function getBaseballH2H(homeId, awayId) {
  const redisKey = `baseball:h2h:${Math.min(homeId, awayId)}-${Math.max(homeId, awayId)}`;
  const cached = await redisGet(redisKey);
  if (cached) return { h2h: cached, fromCache: true };

  const { response } = await apiCall(`/games/h2h?h2h=${homeId}-${awayId}`);
  const h2h = response || [];
  if (h2h.length > 0) await redisSet(redisKey, h2h, 24 * 3600);
  return { h2h, fromCache: false };
}

// ===================== LIVE GAMES =====================
// Single call returns ALL live games today.
export async function getBaseballLiveGames() {
  const { response } = await apiCall(`/games?live=all`);
  return (response || []).filter(g => BASEBALL_LEAGUE_IDS.includes(g.league?.id));
}

export { BASEBALL_LEAGUES, BASEBALL_LEAGUE_IDS };
