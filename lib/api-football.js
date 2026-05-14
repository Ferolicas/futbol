import { ALL_LEAGUE_IDS, LEAGUES } from './leagues';
import {
  getCachedFixtures, cacheFixtures,
  getCachedAnalysis, cacheAnalysis,
  getCachedEndpoint, cacheEndpoint,
  incrementApiCallCount, getApiCallCount,
} from './sanity-cache';
import { redisGet, redisSet } from './redis';

const API_HOST = 'v3.football.api-sports.io';

// ===================== YOUTH FILTER =====================
// Block any youth/sub competition regardless of league ID.
// API-Football uses the league name to identify youth tiers.
const YOUTH_PATTERN = /\bU-?1[2-9]\b|\bU-?2[0-3]\b|\bunder[ -]?(1[2-9]|2[0-3])\b|\byouth\b|\bjunior\b|\bsub-?(1[2-9]|2[0-3])\b/i;
function isYouthLeague(name) {
  return YOUTH_PATTERN.test(name || '');
}

// ===================== CORE =====================

function getApiKey() {
  return process.env.FOOTBALL_API_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || null;
}

// South American leagues use calendar-year seasons (2026 = the 2026 season).
// European leagues use cross-year seasons (2025 = the 2025-2026 season, starts ~July).
const CALENDAR_YEAR_LEAGUES = new Set([
  239, 240, 241, // Colombia
  128, 130, 131, // Argentina
  71, 73, 475, 476, // Brazil
]);

function currentSeason(leagueId) {
  const now = new Date();
  const year = now.getFullYear();
  if (leagueId && CALENDAR_YEAR_LEAGUES.has(Number(leagueId))) {
    return year; // Calendar-year leagues: 2026 season runs in 2026
  }
  // European convention: season starts in July/August
  return now.getMonth() >= 6 ? year : year - 1;
}

// ===================== RATE LIMITER =====================
// API-Football per-minute caps depend on plan tier. The Pro 75k/day plan
// allows 450 req/min ≈ 7.5/s sustained, but bursts of 10–15/s are tolerated
// thanks to the per-second smoothing the API uses internally.
//
// We aim slightly below the burst ceiling to avoid 429s in tight windows.
// The two layers:
// 1. _throttleChain: serial promise chain — each request starts MIN_DELAY_MS
//    after the previous one began. No race condition possible.
// 2. _activeRequests: caps in-flight connections to MAX_CONCURRENT (prevents
//    socket exhaustion if upstream latency spikes).
//
// If you ever see sustained 429s in the /ferney error log, bump MIN_DELAY_MS
// back up to 100–110ms.
const MAX_CONCURRENT = 15;
const MIN_DELAY_MS = 75; // ~13 req/s; the retry-on-429 handler below absorbs spikes
let _activeRequests = 0;
const _queue = [];
let _throttleChain = Promise.resolve();

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
  return new Promise(resolve => _queue.push({ resolve }));
}

function _releaseSlot() {
  _activeRequests--;
  _scheduleNext();
}

// Serial throttle: each call extends the chain by MIN_DELAY_MS.
// Guarantees requests start MIN_DELAY_MS apart — no burst possible.
function _throttle() {
  const myTurn = _throttleChain.then(() => new Promise(r => setTimeout(r, MIN_DELAY_MS)));
  _throttleChain = myTurn;
  return myTurn;
}

export function resetRateLimiter() {
  _activeRequests = 0;
  _queue.length = 0;
  _throttleChain = Promise.resolve();
}

async function apiCall(endpoint) {
  const key = getApiKey();
  if (!key) throw new Error('No API key configured');

  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await _acquireSlot();
    let slotReleased = false;

    const releaseOnce = () => {
      if (!slotReleased) {
        slotReleased = true;
        _releaseSlot();
      }
    };

    try {
      // Serial throttle — guarantees MIN_DELAY_MS between request starts, no race condition
      await _throttle();

      const res = await fetch(`https://${API_HOST}${endpoint}`, {
        headers: { 'x-apisports-key': key },
        cache: 'no-store',
      });

      if (!res.ok) {
        if (res.status === 429) {
          releaseOnce();
          if (attempt < MAX_RETRIES) {
            const backoff = 3000 * (attempt + 1);
            console.log(`[api-football] 429 on ${endpoint}, retry ${attempt + 1} in ${backoff}ms`);
            await new Promise(r => setTimeout(r, backoff));
            continue;
          }
          throw new Error('RATE_LIMIT');
        }
        releaseOnce();
        throw new Error(`API error: ${res.status}`);
      }

      const data = await res.json();

      if (data.errors && Object.keys(data.errors).length > 0) {
        const errMsg = Object.values(data.errors).join('; ');
        if (errMsg.toLowerCase().includes('rate') || errMsg.toLowerCase().includes('limit')) {
          releaseOnce();
          if (attempt < MAX_RETRIES) {
            const backoff = 3000 * (attempt + 1);
            console.log(`[api-football] rate-limit body on ${endpoint}, retry ${attempt + 1} in ${backoff}ms`);
            await new Promise(r => setTimeout(r, backoff));
            continue;
          }
          throw new Error('RATE_LIMIT');
        }
        releaseOnce();
        throw new Error(`API: ${errMsg}`);
      }

      await incrementApiCallCount();
      const remaining = res.headers.get('x-ratelimit-requests-remaining');
      releaseOnce();

      return { response: data.response || [], remaining: remaining ? parseInt(remaining) : null };
    } catch (e) {
      releaseOnce();
      if (e.message === 'RATE_LIMIT' && attempt < MAX_RETRIES) {
        continue;
      }
      throw e;
    }
  }
}

// Cached API call — Redis first (~2ms), then Sanity (~80ms), then API
async function cachedApiCall(cacheKey, endpoint) {
  // Layer 1: Redis (fastest)
  const redisCached = await redisGet(`api:${cacheKey}`);
  if (redisCached !== null && !(Array.isArray(redisCached) && redisCached.length === 0)) {
    return { data: redisCached, fromCache: true };
  }

  // Layer 2: Fresh API call
  try {
    const { response: data } = await apiCall(endpoint);
    if (!Array.isArray(data) || data.length > 0) {
      await cacheEndpoint(cacheKey, data);
    }
    return { data, fromCache: false };
  } catch (e) {
    throw e;
  }
}

// Fresh API call — bypasses cache (for lineups)
async function freshApiCall(cacheKey, endpoint) {
  try {
    const { response: data } = await apiCall(endpoint);
    await cacheEndpoint(cacheKey, data);
    return { data, fromCache: false };
  } catch (e) {
    const cached = await getCachedEndpoint(cacheKey);
    if (cached !== null) return { data: cached, fromCache: true };
    throw e;
  }
}

// ===================== QUOTA =====================

export async function getQuota() {
  const count = await getApiCallCount();
  return {
    used: count,
    date: new Date().toISOString().split('T')[0],
  };
}

// ===================== FIXTURES =====================

export async function getFixtures(date, { forceApi } = {}) {
  if (forceApi) {
    // Bypass all caches — call API-Football directly for real-time data
    const { response: all } = await apiCall(`/fixtures?date=${date}`);
    const postponed = ['PST', 'CANC', 'SUSP', 'ABD'];
    const filtered = all
      .filter(m => ALL_LEAGUE_IDS.includes(m.league.id))
      .filter(m => !isYouthLeague(m.league.name))
      .filter(m => !postponed.includes(m.fixture?.status?.short))
      .map(m => ({
        ...m,
        leagueMeta: LEAGUES[m.league.id] || { country: m.league.country, name: m.league.name, division: 0, gender: 'M' },
      }));
    if (filtered.length > 0) await cacheFixtures(date, filtered);
    return { fixtures: filtered, fromCache: false };
  }

  const cached = await getCachedFixtures(date);
  if (cached) {
    // Check if cache has stale live statuses (match kicked off > 150min ago but still shows live)
    const now = Date.now();
    const LIVE_STATUSES = ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'];
    const hasStaleStatus = cached.some(f => {
      if (!LIVE_STATUSES.includes(f.fixture?.status?.short)) return false;
      const kickoff = new Date(f.fixture.date).getTime();
      return (now - kickoff) > 150 * 60 * 1000; // > 2.5 hours since kickoff
    });

    if (hasStaleStatus) {
      // Cache has impossible live statuses — force refresh from API
      try {
        const { response: all } = await apiCall(`/fixtures?date=${date}`);
        const postponed = ['PST', 'CANC', 'SUSP', 'ABD'];
        const filtered = all
          .filter(m => ALL_LEAGUE_IDS.includes(m.league.id))
          .filter(m => !isYouthLeague(m.league.name))
          .filter(m => !postponed.includes(m.fixture?.status?.short))
          .map(m => ({
            ...m,
            leagueMeta: LEAGUES[m.league.id] || { country: m.league.country, name: m.league.name, division: 0, gender: 'M' },
          }));
        if (filtered.length > 0) await cacheFixtures(date, filtered);
        return { fixtures: filtered, fromCache: false };
      } catch (err) {
        console.error('[api-football:getFixtures] API fetch failed:', err.message);
        // API failed — fix statuses client-side as fallback
        const fixed = cached.map(f => {
          if (!LIVE_STATUSES.includes(f.fixture?.status?.short)) return f;
          const kickoff = new Date(f.fixture.date).getTime();
          if ((now - kickoff) > 150 * 60 * 1000) {
            return { ...f, fixture: { ...f.fixture, status: { ...f.fixture.status, short: 'FT', long: 'Match Finished' } } };
          }
          return f;
        });
        return { fixtures: fixed, fromCache: true, stale: true };
      }
    }

    return { fixtures: cached, fromCache: true };
  }

  try {
    const { response: all } = await apiCall(`/fixtures?date=${date}`);
    const postponed = ['PST', 'CANC', 'SUSP', 'ABD'];
    const filtered = all
      .filter(m => ALL_LEAGUE_IDS.includes(m.league.id))
      .filter(m => !isYouthLeague(m.league.name))
      .filter(m => !postponed.includes(m.fixture?.status?.short))
      .map(m => ({
        ...m,
        leagueMeta: LEAGUES[m.league.id] || { country: m.league.country, name: m.league.name, division: 0, gender: 'M' },
      }));

    if (filtered.length > 0) {
      await cacheFixtures(date, filtered);
    }

    return { fixtures: filtered, fromCache: false };
  } catch (e) {
    throw e;
  }
}

// ===================== FETCH LAST 5 HELPER =====================

async function fetchLast5(teamId, season, finishedStatuses) {
  let allMatches = [];

  // Try requested season first
  try {
    const { data } = await cachedApiCall(
      `fixtures-${teamId}-s${season}`,
      `/fixtures?team=${teamId}&season=${season}`
    );
    allMatches = data || [];
  } catch (e) {
    console.log(`[ANALYSIS] fetchLast5 season ${season} ERROR: ${e.message}`);
  }

  // Filter to finished matches only
  let finished = allMatches
    .filter(f => finishedStatuses.includes(f.fixture?.status?.short))
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));

  // If not enough for player highlights window (10), try previous season
  if (finished.length < 10) {
    try {
      const { data } = await cachedApiCall(
        `fixtures-${teamId}-s${season - 1}`,
        `/fixtures?team=${teamId}&season=${season - 1}`
      );
      const prevFinished = (data || [])
        .filter(f => finishedStatuses.includes(f.fixture?.status?.short));
      finished = [...finished, ...prevFinished.sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))];
    } catch (e2) {
      console.log(`[ANALYSIS] fetchLast5 season ${season - 1} ERROR: ${e2.message}`);
    }
  }

  // Devuelve hasta 10 partidos: los primeros 5 se usan para forma/lambda;
  // los 10 completos para el extractor de jugadores destacados.
  return finished.slice(0, 10);
}

// ===================== REFEREE FACTOR =====================
// Factor aplicado a cardAvg en el modelo de tarjetas. Se calcula como
// ratio entre el promedio del arbitro y el promedio global, con clamp y
// minimo de muestra para evitar sesgos con sample-size bajo.
const REFEREE_FACTOR_MIN_MATCHES = 10;
const REFEREE_FACTOR_CLAMP_MIN = 0.80;
const REFEREE_FACTOR_CLAMP_MAX = 1.20;
const REFEREE_GLOBAL_AVG_TTL = 21600; // 6h
const REFEREE_GLOBAL_AVG_KEY = 'referee:globalAvgCards';
const REFEREE_GLOBAL_AVG_FALLBACK = 3.8;

function normalizeRefereeName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.split(',')[0]?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

async function getGlobalCardsAvg(supabaseAdmin) {
  try {
    const cached = await redisGet(REFEREE_GLOBAL_AVG_KEY);
    if (typeof cached === 'number' && cached > 0) return cached;
  } catch {}
  try {
    const { data, error } = await supabaseAdmin
      .from('referee_stats')
      .select('avg_cards')
      .gte('matches', REFEREE_FACTOR_MIN_MATCHES);
    if (error || !data || data.length === 0) return REFEREE_GLOBAL_AVG_FALLBACK;
    const sum = data.reduce((s, r) => s + Number(r.avg_cards || 0), 0);
    const avg = sum / data.length;
    if (avg > 0) {
      redisSet(REFEREE_GLOBAL_AVG_KEY, avg, REFEREE_GLOBAL_AVG_TTL).catch(() => {});
      return avg;
    }
    return REFEREE_GLOBAL_AVG_FALLBACK;
  } catch (e) {
    console.error('[referee] getGlobalCardsAvg:', e.message);
    return REFEREE_GLOBAL_AVG_FALLBACK;
  }
}

// Devuelve { factor, refereeName, refereeMatches, refereeAvg }.
// factor = 1.0 si: arbitro nulo, sin fila en BD, muestra < 10, o error.
async function computeRefereeFactor(refereeRaw) {
  const name = normalizeRefereeName(refereeRaw);
  if (!name) return { factor: 1, refereeName: null, refereeMatches: 0, refereeAvg: null };

  try {
    const { supabaseAdmin } = await import('./supabase');
    const { data, error } = await supabaseAdmin
      .from('referee_stats')
      .select('avg_cards, matches')
      .eq('name', name)
      .maybeSingle();
    if (error || !data) return { factor: 1, refereeName: name, refereeMatches: 0, refereeAvg: null };

    const matches = Number(data.matches || 0);
    const refAvg  = Number(data.avg_cards || 0);
    if (matches < REFEREE_FACTOR_MIN_MATCHES || refAvg <= 0) {
      return { factor: 1, refereeName: name, refereeMatches: matches, refereeAvg: refAvg };
    }

    const globalAvg = await getGlobalCardsAvg(supabaseAdmin);
    if (!(globalAvg > 0)) return { factor: 1, refereeName: name, refereeMatches: matches, refereeAvg: refAvg };

    const rawFactor = refAvg / globalAvg;
    const factor = Math.max(REFEREE_FACTOR_CLAMP_MIN, Math.min(REFEREE_FACTOR_CLAMP_MAX, rawFactor));
    return { factor, refereeName: name, refereeMatches: matches, refereeAvg: refAvg };
  } catch (e) {
    console.error('[referee] computeRefereeFactor:', e.message);
    return { factor: 1, refereeName: name, refereeMatches: 0, refereeAvg: null };
  }
}

// ===================== MATCH ANALYSIS =====================

export async function analyzeMatch(fixture, { date: requestDate, force } = {}) {
  const fixtureId = fixture.fixture.id;
  const homeId = fixture.teams.home.id;
  const awayId = fixture.teams.away.id;
  const homeLeagueId = fixture.league.id;
  const date = requestDate || new Date().toISOString().split('T')[0];

  // Check if already analyzed today (skip cache entirely when force=true)
  if (!force) {
    const existing = await getCachedAnalysis(fixtureId, date, { strict: true });
    if (existing) return { analysis: existing, fromCache: true, apiCalls: 0 };
  }

  let apiCalls = 0;
  const results = {};

  const todayStr = new Date().toISOString().split('T')[0];
  const finishedStatuses = ['FT', 'AET', 'PEN'];
  const season = currentSeason(homeLeagueId);

  // 1. H2H
  try {
    const { data, fromCache } = await cachedApiCall(
      `h2h-${homeId}-${awayId}-v2`,
      `/fixtures/headtohead?h2h=${homeId}-${awayId}`
    );
    // Filter finished matches only, then take last 10
    results.h2h = (data || [])
      .filter(f => finishedStatuses.includes(f.fixture?.status?.short))
      .slice(-10);
    if (!fromCache) apiCalls++;
    console.log(`[ANALYSIS] H2H ${homeId}-${awayId}: ${results.h2h.length} results (of ${(data||[]).length} total), fromCache=${fromCache}`);
  } catch (e) { console.log(`[ANALYSIS] H2H ERROR: ${e.message}`); results.h2h = []; }

  // 2-3. Home + Away last 5 (parallel — halves per-match time)
  [results.homeLastFive, results.awayLastFive] = await Promise.all([
    fetchLast5(homeId, season, finishedStatuses),
    fetchLast5(awayId, season, finishedStatuses),
  ]);
  console.log(`[ANALYSIS] Home last5 (${homeId}): ${results.homeLastFive.length}, Away last5 (${awayId}): ${results.awayLastFive.length}`);

  // Data quality check — minimum 2 matches per team for reliable probabilities
  const hasMinimumData = results.homeLastFive.length >= 2 && results.awayLastFive.length >= 2;
  if (!hasMinimumData) {
    console.warn(`[ANALYSIS] Insufficient data for fixture ${fixtureId}: home=${results.homeLastFive.length}, away=${results.awayLastFive.length} — analysis will be partial`);
  }
  results.dataQuality = hasMinimumData ? 'good' : 'insufficient';

  // 4-5. Team season stats derived from per-fixture data (last 5 matches)

  // 6. Injuries
  try {
    const { data, fromCache } = await cachedApiCall(
      `injuries-${fixtureId}`,
      `/injuries?fixture=${fixtureId}`
    );
    results.injuries = data;
    if (!fromCache) apiCalls++;
  } catch (err) { console.error('[api-football:injuries]', err.message); results.injuries = []; }

  // 7. Lineups — always fetch fresh, no time-based cache
  try {
    const { data, fromCache } = await freshApiCall(
      `lineups-${fixtureId}`,
      `/fixtures/lineups?fixture=${fixtureId}`
    );
    results.lineups = data && data.length > 0
      ? { available: true, data }
      : { available: false, data: [] };
    if (!fromCache) apiCalls++;
  } catch (err) { console.error('[api-football:lineups]', err.message); results.lineups = { available: false, data: [] }; }

  // 8. Odds — try API-Football first, then enrich with The Odds API
  try {
    const { data, fromCache } = await cachedApiCall(
      `odds-${fixtureId}`,
      `/odds?fixture=${fixtureId}`
    );
    results.odds = data;
    if (!fromCache) apiCalls++;
  } catch (err) { console.error('[api-football:odds]', err.message); results.odds = []; }

  // 8b. Enrich with The Odds API if available (cached odds from Redis)
  try {
    const { redisGet } = await import('./redis');
    const oddsCache = await redisGet(`odds:fixture:${fixtureId}`);
    if (oddsCache?.odds || oddsCache?.matchWinner) {
      results.theOddsApiData = oddsCache.odds || oddsCache;
    }
  } catch (err) { results.theOddsApiData = null; }

  // 9-10. REMOVED: Season player stats — not available on free plan for current season
  // Usual XI is derived from per-fixture player data instead

  // 10. Match statistics — usamos hasta 10 partidos para extracción de stats
  // de jugadores (goleadores y rematadores se evalúan en ventana de 10).
  // Para forma/lambda mantenemos los 5 más recientes.
  const homeLast10 = (results.homeLastFive || []).slice(0, 10);
  const awayLast10 = (results.awayLastFive || []).slice(0, 10);
  results.homeLastFive = homeLast10.slice(0, 5);
  results.awayLastFive = awayLast10.slice(0, 5);

  const homeFixtureIds = homeLast10.map(f => f.fixture?.id).filter(Boolean);
  const awayFixtureIds = awayLast10.map(f => f.fixture?.id).filter(Boolean);
  // Also include H2H fixture IDs for corners/cards enrichment
  const h2hFixtureIds = (results.h2h || []).map(f => f.fixture?.id).filter(Boolean);
  const uniqueFixtureIds = [...new Set([...homeFixtureIds, ...awayFixtureIds, ...h2hFixtureIds])];

  // 10-11. Fetch match stats, players, AND events in parallel for all fixtures
  const matchStatsMap = {};
  const matchPlayersMap = {};
  const matchEventsMap = {};
  await Promise.all(uniqueFixtureIds.map(async (fid) => {
    const [statsResult, playersResult, eventsResult] = await Promise.allSettled([
      cachedApiCall(`matchstats-${fid}`, `/fixtures/statistics?fixture=${fid}`),
      cachedApiCall(`matchplayers-${fid}`, `/fixtures/players?fixture=${fid}`),
      cachedApiCall(`matchevents-${fid}`, `/fixtures/events?fixture=${fid}`),
    ]);
    matchStatsMap[fid] = statsResult.status === 'fulfilled' ? statsResult.value.data : [];
    if (statsResult.status === 'fulfilled' && !statsResult.value.fromCache) apiCalls++;
    matchPlayersMap[fid] = playersResult.status === 'fulfilled' ? playersResult.value.data : [];
    if (playersResult.status === 'fulfilled' && !playersResult.value.fromCache) apiCalls++;
    matchEventsMap[fid] = eventsResult.status === 'fulfilled' ? eventsResult.value.data : [];
    if (eventsResult.status === 'fulfilled' && !eventsResult.value.fromCache) apiCalls++;
  }));

  // Backfill: if any fixture in matchStatsMap has empty/missing stats, fetch directly
  const emptyStatsFids = uniqueFixtureIds.filter(fid => {
    const s = matchStatsMap[fid];
    return !s || (Array.isArray(s) && s.length === 0);
  });
  if (emptyStatsFids.length > 0) {
    await Promise.all(emptyStatsFids.map(async (fid) => {
      try {
        const { response: data } = await apiCall(`/fixtures/statistics?fixture=${fid}`);
        apiCalls++;
        if (data && data.length > 0) {
          matchStatsMap[fid] = data;
          await cacheEndpoint(`matchstats-${fid}`, data);
        }
      } catch {}
    }));
  }

  // ===== DERIVE USUAL XI FROM MATCH DATA =====
  console.log(`[ANALYSIS] Deriving XI: homeFixtureIds=${homeFixtureIds.length}, awayFixtureIds=${awayFixtureIds.length}, matchPlayersMapKeys=${Object.keys(matchPlayersMap).length}`);
  const homeUsualXI = deriveUsualXIFromMatches(matchPlayersMap, homeFixtureIds, homeId);
  const awayUsualXI = deriveUsualXIFromMatches(matchPlayersMap, awayFixtureIds, awayId);
  console.log(`[ANALYSIS] XI result: home=${homeUsualXI.length}, away=${awayUsualXI.length}`);

  // ===== FILTER INJURIES BY USUAL XI =====
  const homeUsualIds = new Set(homeUsualXI.map(p => p.id));
  const awayUsualIds = new Set(awayUsualXI.map(p => p.id));
  const allUsualIds = new Set([...homeUsualIds, ...awayUsualIds]);

  const filteredInjuries = (results.injuries || []).filter(inj => {
    const playerId = inj.player?.id;
    return allUsualIds.has(playerId);
  });

  // ===== DERIVE CORNER/CARD STATS =====
  const homeMatchStats = homeFixtureIds.map(fid => matchStatsMap[fid]).filter(Boolean);
  const awayMatchStats = awayFixtureIds.map(fid => matchStatsMap[fid]).filter(Boolean);
  const cornerCardData = extractCornerCardData(homeMatchStats, awayMatchStats, homeId, awayId);

  // ===== DERIVE PLAYER HIGHLIGHTS (shooters, scorers) =====
  const playerHighlights = extractPlayerHighlights(
    homeFixtureIds, awayFixtureIds, matchPlayersMap, homeId, awayId,
    fixture.teams.home.name, fixture.teams.away.name
  );

  // ===== GOAL TIMING DATA FROM EVENTS =====
  const goalTimingData = extractGoalTimingData(homeFixtureIds, awayFixtureIds, matchEventsMap, homeId, awayId);

  // ===== ENRICH LAST 5 MATCHES WITH DISPLAY DATA =====
  const homeLastFiveEnriched = enrichLastFiveMatches(results.homeLastFive || [], homeId, matchStatsMap);
  const awayLastFiveEnriched = enrichLastFiveMatches(results.awayLastFive || [], awayId, matchStatsMap);

  // ===== ENRICH H2H WITH CORNERS/CARDS (dedicated fetch) =====
  const h2hToEnrich = (results.h2h || []).slice(-10);
  await Promise.all(h2hToEnrich.map(async (match) => {
    const fid = match.fixture?.id;
    if (!fid) return;
    // Use matchStatsMap if already populated with real data
    if (matchStatsMap[fid] && Array.isArray(matchStatsMap[fid]) && matchStatsMap[fid].length > 0) return;
    // Otherwise fetch directly
    try {
      const { response: data } = await apiCall(`/fixtures/statistics?fixture=${fid}`);
      apiCalls++;
      if (data && data.length > 0) {
        matchStatsMap[fid] = data;
        await cacheEndpoint(`matchstats-${fid}`, data);
      }
    } catch (e) {
      console.log(`[ANALYSIS] H2H stats fetch failed for fixture ${fid}: ${e.message}`);
    }
  }));
  const h2hEnriched = enrichH2HMatches(h2hToEnrich, matchStatsMap);

  // ===== STANDINGS POSITIONS (fetched BEFORE probability computation) =====
  // Positions are used by Dixon-Coles as a quality adjustment, so they must be
  // available when computeAllProbabilities is called.
  let homePosition = null;
  let awayPosition = null;
  try {
    const leagueId = fixture.league.id;
    const cachedPositions = await getCachedStandingsPositions([leagueId]);
    if (cachedPositions[homeId]) homePosition = cachedPositions[homeId];
    if (cachedPositions[awayId]) awayPosition = cachedPositions[awayId];
    if (homePosition === null || awayPosition === null) {
      const { data: standingsData, fromCache: standingsFromCache } = await cachedApiCall(
        `standings-${leagueId}-${season}`,
        `/standings?league=${leagueId}&season=${season}`
      );
      if (!standingsFromCache) apiCalls++;
      if (standingsData?.[0]?.league?.standings) {
        const table = standingsData[0].league.standings.flat();
        for (const entry of table) {
          if (entry.team?.id === homeId) homePosition = entry.rank;
          if (entry.team?.id === awayId) awayPosition = entry.rank;
        }
      }
    }
  } catch (e) {
    console.log(`[ANALYSIS] Standings fetch error: ${e.message}`);
  }

  // Build analysis object
  const analysis = {
    fixtureId,
    date,
    homeTeam: fixture.teams.home.name,
    awayTeam: fixture.teams.away.name,
    homeLogo: fixture.teams.home.logo,
    awayLogo: fixture.teams.away.logo,
    homeId,
    awayId,
    kickoff: fixture.fixture.date,
    league: fixture.league.name,
    leagueId: fixture.league.id,
    leagueLogo: fixture.league.logo,
    leagueCountry: fixture.league.country,
    leagueRound: fixture.league.round || null,
    status: fixture.fixture.status,
    goals: fixture.goals,
    h2h: h2hEnriched,
    homeLastFive: homeLastFiveEnriched,
    awayLastFive: awayLastFiveEnriched,
    homeStats: null,
    awayStats: null,
    injuries: results.injuries || [],
    filteredInjuries,
    homeUsualXI,
    awayUsualXI,
    lineups: results.lineups || { available: false, data: [] },
    odds: mergeOdds(extractOdds(results.odds), results.theOddsApiData),
    cornerCardData,
    playerHighlights,
    goalTimingData,
    homePosition,
    awayPosition,
  };

  // Referee factor — multiplica cardAvg segun el historico del arbitro.
  // Si no hay arbitro asignado o sample < 10 partidos, factor = 1.0 (sin efecto).
  const refereeInfo = await computeRefereeFactor(fixture.fixture?.referee);
  analysis.referee = fixture.fixture?.referee || null;
  analysis.refereeFactor = refereeInfo.factor;
  analysis.refereeStats = {
    name: refereeInfo.refereeName,
    matches: refereeInfo.refereeMatches,
    avgCards: refereeInfo.refereeAvg,
  };

  // Compute probabilities server-side and include in analysis
  const { computeAllProbabilities } = await import('./calculations');
  const calculatedProbabilities = computeAllProbabilities(analysis);
  // Apply isotonic calibration (dc-v1.1) — mutates in place, sets model_version
  const { calibrateProbabilities } = await import('./calibration');
  await calibrateProbabilities(calculatedProbabilities);
  analysis.calculatedProbabilities = calculatedProbabilities;

  // Compute combinada server-side
  const { buildCombinada } = await import('./combinada');
  const teamNames = { home: analysis.homeTeam, away: analysis.awayTeam };
  analysis.combinada = buildCombinada(calculatedProbabilities, analysis.odds, analysis.playerHighlights, teamNames);

  // Save to Redis + Supabase
  await cacheAnalysis(fixtureId, analysis).catch(e => console.error(`[ANALYSIS] cache save failed ${fixtureId}:`, e.message));

  // Save prediction snapshot to match_predictions (fire-and-forget)
  _savePrediction(analysis, calculatedProbabilities).catch(() => {});

  return { analysis, fromCache: false, apiCalls };
}

// ===================== REFRESH LINEUPS =====================

export async function refreshLineups(fixtureId) {
  // Do NOT silently swallow errors — let caller handle rate limit and API errors
  const { response: data } = await apiCall(`/fixtures/lineups?fixture=${fixtureId}`);
  const lineups = data && data.length > 0
    ? { available: true, data }
    : { available: false, data: [] };
  await cacheEndpoint(`lineups-${fixtureId}`, data).catch(err => console.error('[api-football:refreshLineups] cache failed:', err.message));
  return lineups;
}

// ===================== REFRESH INJURIES =====================

export async function refreshInjuries(fixtureId) {
  try {
    const { response: data } = await apiCall(`/injuries?fixture=${fixtureId}`);
    await cacheEndpoint(`injuries-${fixtureId}`, data);
    return data;
  } catch {
    return [];
  }
}

// ===================== DERIVE USUAL XI FROM MATCH DATA =====================

function deriveUsualXIFromMatches(matchPlayersMap, fixtureIds, teamId) {
  if (!fixtureIds || fixtureIds.length === 0) return [];

  const playerAppearances = {}; // playerId -> { id, name, photo, position, appearances, totalMinutes }

  for (const fid of fixtureIds) {
    const matchData = matchPlayersMap[fid];
    if (!matchData || !Array.isArray(matchData)) continue;

    for (const teamData of matchData) {
      if (teamData.team?.id !== teamId) continue;
      for (const p of (teamData.players || [])) {
        const pid = p.player?.id;
        if (!pid) continue;

        const minutes = p.statistics?.[0]?.games?.minutes || 0;
        if (minutes <= 0) continue;

        if (!playerAppearances[pid]) {
          playerAppearances[pid] = {
            id: pid,
            name: p.player?.name || '?',
            photo: p.player?.photo,
            position: p.statistics?.[0]?.games?.position || 'N/A',
            appearances: 0,
            totalMinutes: 0,
          };
        }
        playerAppearances[pid].appearances++;
        playerAppearances[pid].totalMinutes += minutes;
      }
    }
  }

  // Sort by appearances (most frequent starters), then by total minutes
  return Object.values(playerAppearances)
    .sort((a, b) => b.appearances - a.appearances || b.totalMinutes - a.totalMinutes)
    .slice(0, 11);
}

// ===================== EXTRACT CORNER & CARD DATA =====================

function extractCornerCardData(homeMatchStats, awayMatchStats, homeId, awayId) {
  let homeCornersFor = 0, homeCornersAgainst = 0, homeCornerMatches = 0;
  let awayCornersFor = 0, awayCornersAgainst = 0, awayCornerMatches = 0;
  let homeYellows = 0, homeReds = 0, homeCardMatches = 0;
  let awayYellows = 0, awayReds = 0, awayCardMatches = 0;

  // Per-match arrays for frequency-based probability calculation
  const homeCornersPerMatch = [];
  const awayCornersPerMatch = [];
  const homeCardsPerMatch = [];
  const awayCardsPerMatch = [];

  const processStats = (statsArray, teamId, isHome) => {
    statsArray.forEach(matchStats => {
      if (!matchStats || !Array.isArray(matchStats)) return;

      let teamCorners = 0, oppCorners = 0;
      let teamYellow = 0, teamRed = 0;
      let foundCorner = false, foundCard = false;

      matchStats.forEach(teamData => {
        const tid = teamData.team?.id;
        const stats = teamData.statistics || [];

        const cornerStat = stats.find(s => s.type === 'Corner Kicks');
        const yellowStat = stats.find(s => s.type === 'Yellow Cards');
        const redStat = stats.find(s => s.type === 'Red Cards');

        if (cornerStat && cornerStat.value != null) {
          foundCorner = true;
          if (tid === teamId) {
            teamCorners = cornerStat.value || 0;
          } else {
            oppCorners = cornerStat.value || 0;
          }
        }

        if (tid === teamId) {
          if (yellowStat && yellowStat.value != null) {
            teamYellow = yellowStat.value || 0;
            foundCard = true;
          }
          if (redStat && redStat.value != null) {
            teamRed = redStat.value || 0;
          }
        }
      });

      if (foundCorner) {
        const totalCorners = teamCorners + oppCorners;
        if (isHome) {
          homeCornersFor += teamCorners;
          homeCornersAgainst += oppCorners;
          homeCornerMatches++;
          homeCornersPerMatch.push(totalCorners);
        } else {
          awayCornersFor += teamCorners;
          awayCornersAgainst += oppCorners;
          awayCornerMatches++;
          awayCornersPerMatch.push(totalCorners);
        }
      }

      if (foundCard) {
        const totalCards = teamYellow + teamRed;
        if (isHome) {
          homeYellows += teamYellow;
          homeReds += teamRed;
          homeCardMatches++;
          homeCardsPerMatch.push(totalCards);
        } else {
          awayYellows += teamYellow;
          awayReds += teamRed;
          awayCardMatches++;
          awayCardsPerMatch.push(totalCards);
        }
      }
    });
  };

  processStats(homeMatchStats, homeId, true);
  processStats(awayMatchStats, awayId, false);

  const hcm = homeCornerMatches || 1;
  const acm = awayCornerMatches || 1;
  const hCardM = homeCardMatches || 1;
  const aCardM = awayCardMatches || 1;

  return {
    homeCornersAvg: +(homeCornersFor / hcm).toFixed(1),
    homeCornersAgainstAvg: +(homeCornersAgainst / hcm).toFixed(1),
    awayCornersAvg: +(awayCornersFor / acm).toFixed(1),
    awayCornersAgainstAvg: +(awayCornersAgainst / acm).toFixed(1),
    totalCornersAvg: +((homeCornersFor / hcm) + (awayCornersFor / acm)).toFixed(1),
    homeYellowsAvg: +(homeYellows / hCardM).toFixed(1),
    homeRedsAvg: +(homeReds / hCardM).toFixed(2),
    awayYellowsAvg: +(awayYellows / aCardM).toFixed(1),
    awayRedsAvg: +(awayReds / aCardM).toFixed(2),
    totalCardsAvg: +((homeYellows / hCardM) + (awayYellows / aCardM)).toFixed(1),
    totalRedsAvg: +((homeReds / hCardM) + (awayReds / aCardM)).toFixed(2),
    hasRealData: homeCornerMatches > 0 || awayCornerMatches > 0,
    // Per-match arrays for frequency-based probability
    homeCornersPerMatch,
    awayCornersPerMatch,
    homeCardsPerMatch,
    awayCardsPerMatch,
  };
}

// ===================== EXTRACT PLAYER HIGHLIGHTS =====================

function extractPlayerHighlights(homeFixtureIds, awayFixtureIds, matchPlayersMap, homeId, awayId, homeTeamName, awayTeamName) {
  const playerMap = {}; // playerId -> { name, team, teamName, shotsOnGoalByMatch, goalsByMatch }

  const processTeamFixtures = (fixtureIds, teamId, teamName) => {
    fixtureIds.forEach((fid, matchIndex) => {
      const matchData = matchPlayersMap[fid];
      if (!matchData || !Array.isArray(matchData)) return;

      matchData.forEach(teamData => {
        if (teamData.team?.id !== teamId) return;
        (teamData.players || []).forEach(p => {
          const pid = p.player?.id;
          if (!pid) return;

          if (!playerMap[pid]) {
            playerMap[pid] = {
              id: pid,
              name: p.player?.name || '?',
              photo: p.player?.photo,
              team: teamId,
              teamName,
              shotsOnGoal: [],
              goals: [],
              fouls: [],
              yellows: [],
              totalShots: 0,
              totalGoals: 0,
              totalFouls: 0,
              totalYellows: 0,
            };
          }

          const shots   = p.statistics?.[0]?.shots?.on || 0;
          const goals   = p.statistics?.[0]?.goals?.total || 0;
          const fouls   = p.statistics?.[0]?.fouls?.committed || 0;
          const yellow  = p.statistics?.[0]?.cards?.yellow || 0;

          playerMap[pid].shotsOnGoal.push(shots);
          playerMap[pid].goals.push(goals);
          playerMap[pid].fouls.push(fouls);
          playerMap[pid].yellows.push(yellow);
          playerMap[pid].totalShots   += shots;
          playerMap[pid].totalGoals   += goals;
          playerMap[pid].totalFouls   += fouls;
          playerMap[pid].totalYellows += yellow;
        });
      });
    });
  };

  processTeamFixtures(homeFixtureIds, homeId, homeTeamName);
  processTeamFixtures(awayFixtureIds, awayId, awayTeamName);

  const allPlayers = Object.values(playerMap);

  // Consistent shooters: al menos 1 remate a puerta en 8+ de los últimos 10 partidos
  const shooters = allPlayers
    .filter(p => p.shotsOnGoal.length >= 8 && p.shotsOnGoal.filter(s => s >= 1).length >= 8)
    .sort((a, b) => b.totalShots - a.totalShots)
    .slice(0, 8);

  // Scorers in streak: al menos 1 gol en 8+ de los últimos 10 partidos
  const scorers = allPlayers
    .filter(p => p.goals.length >= 8 && p.goals.filter(g => g >= 1).length >= 8)
    .sort((a, b) => b.totalGoals - a.totalGoals)
    .slice(0, 8);

  // Consistent foulers: ≥1 falta cometida en 8+ de los últimos 10 partidos
  const foulers = allPlayers
    .filter(p => p.fouls.length >= 8 && p.fouls.filter(f => f >= 1).length >= 8)
    .sort((a, b) => b.totalFouls - a.totalFouls)
    .slice(0, 8);

  // Frequent bookers: ≥1 amarilla en 5+ de los últimos 10 partidos
  const bookers = allPlayers
    .filter(p => p.yellows.length >= 8 && p.yellows.filter(y => y >= 1).length >= 5)
    .sort((a, b) => b.totalYellows - a.totalYellows)
    .slice(0, 8);

  return { shooters, scorers, foulers, bookers };
}

// ===================== GOAL TIMING DATA =====================

function extractGoalTimingData(homeFixtureIds, awayFixtureIds, matchEventsMap, homeId, awayId) {
  const periods = ['0-15', '15-30', '30-45', '45-60', '60-75', '75-90'];
  const initPeriods = () => {
    const obj = {};
    for (const p of periods) { obj[p] = { scored: 0, conceded: 0 }; }
    return obj;
  };

  const home = { periods: initPeriods(), totalMatches: 0 };
  const away = { periods: initPeriods(), totalMatches: 0 };

  const getPeriod = (minute) => {
    const m = parseInt(minute) || 0;
    if (m <= 15) return '0-15';
    if (m <= 30) return '15-30';
    if (m <= 45) return '30-45';
    if (m <= 60) return '45-60';
    if (m <= 75) return '60-75';
    return '75-90';
  };

  const processFixtures = (fixtureIds, teamId, teamData) => {
    for (const fid of fixtureIds) {
      const events = matchEventsMap[fid];
      if (!events || !Array.isArray(events)) continue;
      teamData.totalMatches++;

      for (const event of events) {
        if (event.type !== 'Goal') continue;
        // Skip own goals in the scored count (they count as conceded for the team)
        const minute = event.time?.elapsed;
        if (!minute) continue;
        const period = getPeriod(minute);
        const scoringTeamId = event.team?.id;

        if (scoringTeamId === teamId) {
          if (event.detail === 'Own Goal') {
            teamData.periods[period].conceded++;
          } else {
            teamData.periods[period].scored++;
          }
        } else {
          if (event.detail === 'Own Goal') {
            teamData.periods[period].scored++;
          } else {
            teamData.periods[period].conceded++;
          }
        }
      }
    }
  };

  processFixtures(homeFixtureIds, homeId, home);
  processFixtures(awayFixtureIds, awayId, away);

  return { home, away, periods };
}

// ===================== ENRICH LAST 5 MATCHES =====================

function enrichLastFiveMatches(matches, teamId, matchStatsMap = {}) {
  let isFirst = true;
  return matches.map(m => {
    const isHome = m.teams?.home?.id === teamId;
    const goalsFor = isHome ? m.goals?.home : m.goals?.away;
    const goalsAgainst = isHome ? m.goals?.away : m.goals?.home;
    const opponent = isHome ? m.teams?.away : m.teams?.home;

    let result = 'D';
    if (goalsFor != null && goalsAgainst != null) {
      if (goalsFor > goalsAgainst) result = 'W';
      else if (goalsFor < goalsAgainst) result = 'L';
    }

    // Extract corners and cards from match statistics
    let corners = null;
    let yellowCards = null;
    let redCards = null;
    const fid = m.fixture?.id;
    const stats = matchStatsMap[fid];

    // Diagnostic log for first match
    if (isFirst) {
      const hasStats = !!(stats && Array.isArray(stats) && stats.length > 0);
      console.log(`[ENRICH-L5] fid=${fid}, statsFound=${hasStats}, statsLength=${Array.isArray(stats) ? stats.length : 'N/A'}, statsKeys=${hasStats ? JSON.stringify(stats[0]?.statistics?.slice(0,3)?.map(s => s.type)) : 'none'}`);
      isFirst = false;
    }

    if (stats && Array.isArray(stats)) {
      const getVal = (tid, type) => {
        const teamStats = stats.find(s => s.team?.id === tid);
        const stat = (teamStats?.statistics || []).find(s => s.type === type);
        return stat?.value || 0;
      };
      const homeId = m.teams?.home?.id;
      const awayId = m.teams?.away?.id;
      corners = { home: getVal(homeId, 'Corner Kicks'), away: getVal(awayId, 'Corner Kicks') };
      corners.total = corners.home + corners.away;
      yellowCards = { home: getVal(homeId, 'Yellow Cards'), away: getVal(awayId, 'Yellow Cards') };
      yellowCards.total = yellowCards.home + yellowCards.away;
      redCards = { home: getVal(homeId, 'Red Cards'), away: getVal(awayId, 'Red Cards') };
      redCards.total = redCards.home + redCards.away;
    }

    return {
      ...m,
      // Enriched display fields
      _enriched: {
        isHome,
        result,
        goalsFor,
        goalsAgainst,
        opponentName: opponent?.name || '?',
        opponentLogo: opponent?.logo || null,
        score: `${m.goals?.home ?? '?'}-${m.goals?.away ?? '?'}`,
        corners,
        yellowCards,
        redCards,
      },
    };
  });
}

// ===================== ENRICH H2H WITH STATS =====================

function enrichH2HMatches(h2hMatches, matchStatsMap = {}) {
  let isFirst = true;
  return h2hMatches.map(m => {
    const fid = m.fixture?.id;
    const stats = matchStatsMap[fid];
    let corners = null;
    let yellowCards = null;
    let redCards = null;

    // Diagnostic log for first match
    if (isFirst) {
      const hasStats = !!(stats && Array.isArray(stats) && stats.length > 0);
      console.log(`[ENRICH-H2H] fid=${fid}, statsFound=${hasStats}, statsLength=${Array.isArray(stats) ? stats.length : 'N/A'}`);
      if (hasStats) {
        const sampleTeam = stats[0];
        const sampleTypes = (sampleTeam?.statistics || []).slice(0, 5).map(s => `${s.type}=${s.value}`);
        console.log(`[ENRICH-H2H] sample team=${sampleTeam?.team?.name}, stats=[${sampleTypes.join(', ')}]`);
      }
      isFirst = false;
    }

    if (stats && Array.isArray(stats) && stats.length > 0) {
      const getVal = (tid, type) => {
        const teamStats = stats.find(s => s.team?.id === tid);
        const stat = (teamStats?.statistics || []).find(s => s.type === type);
        return stat?.value || 0;
      };
      const homeId = m.teams?.home?.id;
      const awayId = m.teams?.away?.id;
      corners = { home: getVal(homeId, 'Corner Kicks'), away: getVal(awayId, 'Corner Kicks') };
      corners.total = corners.home + corners.away;
      yellowCards = { home: getVal(homeId, 'Yellow Cards'), away: getVal(awayId, 'Yellow Cards') };
      yellowCards.total = yellowCards.home + yellowCards.away;
      redCards = { home: getVal(homeId, 'Red Cards'), away: getVal(awayId, 'Red Cards') };
      redCards.total = redCards.home + redCards.away;
    }

    return {
      ...m,
      _stats: { corners, yellowCards, redCards },
    };
  });
}

// ===================== HELPERS =====================

// Casas de apuestas autorizadas — únicas que pueden ofrecer una opción.
// Si una opción NO existe en ninguna de estas, no se muestra al usuario.
const ALLOWED_BOOKMAKERS = ['bwin', 'bet365', '1xbet', 'betano', 'betplay', 'wplay', 'caliente', 'rushbet'];

function normalizeBkName(name) {
  return (name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s.\-_]/g, '');
}

function matchAllowedBookmaker(bkName) {
  const n = normalizeBkName(bkName);
  if (!n) return null;
  for (const allowed of ALLOWED_BOOKMAKERS) {
    if (n.includes(allowed)) return allowed;
  }
  return null;
}

// Bet-name dictionaries per market family. Strict equality only — NEVER use
// .includes() because 'Total - Cards' overlaps with 'Home Team Cards' and
// caused per-team cuotas to be served as if they were total-match cuotas.
const BET_NAMES = {
  matchWinner: ['Match Winner', 'Full Time Result', '1X2'],
  overUnder:   ['Goals Over/Under', 'Over/Under', 'Total Goals'],
  btts:        ['Both Teams Score', 'Both Teams To Score'],
  cornersTotal:['Total - Corners', 'Corners Over Under', 'Corners Over/Under', 'Total Corners', 'Corners 2-Way'],
  cardsTotal:  ['Total - Cards', 'Cards Over Under', 'Cards Over/Under', 'Total Cards', 'Total Bookings'],
  homeCorners: ['Total Corners - Home', 'Home Team Total Corners', 'Home Corners Over/Under', 'Home Team Corners'],
  awayCorners: ['Total Corners - Away', 'Away Team Total Corners', 'Away Corners Over/Under', 'Away Team Corners'],
  homeCards:   ['Total Bookings - Home', 'Home Team Cards', 'Home Cards Over/Under', 'Home Team Bookings', 'Home Team Total Cards'],
  awayCards:   ['Total Bookings - Away', 'Away Team Cards', 'Away Cards Over/Under', 'Away Team Bookings', 'Away Team Total Cards'],
  homeGoals:   ['Home Total Goals', 'Home Team Total Goals', 'Total - Home', 'Home Team Goals Over/Under'],
  awayGoals:   ['Away Total Goals', 'Away Team Total Goals', 'Total - Away', 'Away Team Goals Over/Under'],
  scorer:      ['Anytime Goal Scorer', 'Anytime Goalscorer', 'Player Anytime Goalscorer', 'Anytime Scorer'],
  shots:       ['Player Shots on Target', 'Player Shots On Target', 'Shots On Target', 'Player Total Shots on Target', 'Player Shots on Goal'],
  fouls:       ['Player Fouls Committed', 'Player Total Fouls', 'Player Fouls', 'Fouls Committed'],
  booked:      ['Player to be Booked', 'To Be Booked', 'Anytime Booking', 'Player Anytime Card'],
};

const matchesBetName = (betName, family) => {
  if (!betName) return false;
  const list = BET_NAMES[family];
  return list && list.includes(betName);
};

// Normalize player name for fuzzy match between odds payload and player highlights.
function normalizePlayerName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractOdds(oddsData) {
  if (!oddsData || !Array.isArray(oddsData) || oddsData.length === 0) return null;

  const allBks = oddsData[0]?.bookmakers || [];
  if (allBks.length === 0) return null;

  // Filter to ONLY the 8 authorized bookmakers
  const bookmakers = allBks.filter(b => matchAllowedBookmaker(b.name));
  if (bookmakers.length === 0) return null;

  // Aggregate best odd per market value across the allowed bookmakers.
  // Returns null if no allowed bookmaker offers this market.
  const aggregateOdds = (family, keyFn) => {
    const result = {};
    for (const bk of bookmakers) {
      const bet = (bk.bets || []).find(b => matchesBetName(b.name, family));
      if (!bet?.values?.length) continue;
      for (const v of bet.values) {
        const key = keyFn(v);
        if (!key) continue;
        const odd = parseFloat(v.odd);
        if (!isFinite(odd) || odd <= 1) continue;
        if (!result[key] || odd > result[key]) result[key] = odd;
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  };

  const normalizeOverUnderKey = (v) => {
    // Accept "Over 1.5", "Under 2.5", "Over_1_5", etc. → "Over_1_5"
    const raw = v.value?.toString().trim();
    if (!raw) return null;
    return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  };

  const result = {};

  // ── Total-match markets ──
  const mw = aggregateOdds('matchWinner', v => ({ Home: 'home', Draw: 'draw', Away: 'away' })[v.value] || null);
  if (mw) result.matchWinner = mw;

  const ou = aggregateOdds('overUnder', normalizeOverUnderKey);
  if (ou) result.overUnder = ou;

  const btts = aggregateOdds('btts', v => v.value?.toLowerCase() || null);
  if (btts) result.btts = btts;

  const corners = aggregateOdds('cornersTotal', normalizeOverUnderKey);
  if (corners) result.corners = corners;

  const cards = aggregateOdds('cardsTotal', normalizeOverUnderKey);
  if (cards) result.cards = cards;

  // ── Per-team markets ──
  const hCorners = aggregateOdds('homeCorners', normalizeOverUnderKey);
  if (hCorners) result.homeCorners = hCorners;
  const aCorners = aggregateOdds('awayCorners', normalizeOverUnderKey);
  if (aCorners) result.awayCorners = aCorners;

  const hCards = aggregateOdds('homeCards', normalizeOverUnderKey);
  if (hCards) result.homeCards = hCards;
  const aCards = aggregateOdds('awayCards', normalizeOverUnderKey);
  if (aCards) result.awayCards = aCards;

  const hGoals = aggregateOdds('homeGoals', normalizeOverUnderKey);
  if (hGoals) result.homeGoals = hGoals;
  const aGoals = aggregateOdds('awayGoals', normalizeOverUnderKey);
  if (aGoals) result.awayGoals = aGoals;

  // ── Player markets — keyed by normalized player name ──
  const playerKey = v => {
    const raw = v.value?.toString();
    const norm = normalizePlayerName(raw);
    return norm || null;
  };
  const scorer = aggregateOdds('scorer', playerKey);
  const shots  = aggregateOdds('shots',  playerKey);
  const fouls  = aggregateOdds('fouls',  playerKey);
  const booked = aggregateOdds('booked', playerKey);
  if (scorer || shots || fouls || booked) {
    result.players = {};
    if (scorer) result.players.scorer = scorer;
    if (shots)  result.players.shots  = shots;
    if (fouls)  result.players.fouls  = fouls;
    if (booked) result.players.booked = booked;
  }

  result.bookmaker = bookmakers[0]?.name || null;
  result.allowedOnly = true;

  // Extract odds from ALL allowed bookmakers for country-based selection
  result.allBookmakerOdds = bookmakers.map(bk => {
    const entry = { id: bk.id, name: bk.name };
    const findBet = (family) => (bk.bets || []).find(b => matchesBetName(b.name, family));

    const bkMW = findBet('matchWinner');
    if (bkMW) {
      entry.matchWinner = {};
      for (const v of bkMW.values || []) {
        if (v.value === 'Home') entry.matchWinner.home = parseFloat(v.odd);
        if (v.value === 'Draw') entry.matchWinner.draw = parseFloat(v.odd);
        if (v.value === 'Away') entry.matchWinner.away = parseFloat(v.odd);
      }
    }
    const bkOU = findBet('overUnder');
    if (bkOU) {
      entry.overUnder = {};
      for (const v of bkOU.values || []) {
        const key = normalizeOverUnderKey(v);
        if (key) entry.overUnder[key] = parseFloat(v.odd);
      }
    }
    const bkBTTS = findBet('btts');
    if (bkBTTS) {
      entry.btts = {};
      for (const v of bkBTTS.values || []) {
        entry.btts[v.value.toLowerCase()] = parseFloat(v.odd);
      }
    }
    const bkCorners = findBet('cornersTotal');
    if (bkCorners) {
      entry.corners = {};
      for (const v of bkCorners.values || []) {
        const key = normalizeOverUnderKey(v);
        if (key) entry.corners[key] = parseFloat(v.odd);
      }
    }
    const bkCards = findBet('cardsTotal');
    if (bkCards) {
      entry.cards = {};
      for (const v of bkCards.values || []) {
        const key = normalizeOverUnderKey(v);
        if (key) entry.cards[key] = parseFloat(v.odd);
      }
    }
    return entry;
  }).filter(bk => bk.matchWinner || bk.overUnder || bk.btts || bk.corners || bk.cards);

  return result;
}

// ===================== MERGE ODDS SOURCES =====================
// Merges odds from API-Football and The Odds API, preferring API-Football as primary
// and using The Odds API to fill gaps (especially for bookmakers not in API-Football)

function mergeOdds(apiFootballOdds, theOddsApiData) {
  // Both inputs are already filtered to the 8 allowed bookmakers in their extract* functions.
  if (!apiFootballOdds && theOddsApiData) return theOddsApiData;
  if (!theOddsApiData || !apiFootballOdds) return apiFootballOdds;

  const merged = { ...apiFootballOdds };

  // Take BEST odd per market value from either source (max for the user)
  const mergeBest = (a, b) => {
    if (!a) return b || null;
    if (!b) return a;
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (!isFinite(v) || v <= 1) continue;
      if (!out[k] || v > out[k]) out[k] = v;
    }
    return out;
  };

  merged.matchWinner = mergeBest(merged.matchWinner, theOddsApiData.matchWinner);
  merged.overUnder   = mergeBest(merged.overUnder,   theOddsApiData.overUnder);
  merged.btts        = mergeBest(merged.btts,        theOddsApiData.btts);
  merged.corners     = mergeBest(merged.corners,     theOddsApiData.corners);
  merged.cards       = mergeBest(merged.cards,       theOddsApiData.cards);

  // Per-team (only API-Football supplies these today — The Odds API soccer
  // plan returns h2h+totals, no per-team or player props — but the mergeBest
  // call is harmless if theOddsApiData ever ships them later).
  merged.homeCorners = mergeBest(merged.homeCorners, theOddsApiData.homeCorners);
  merged.awayCorners = mergeBest(merged.awayCorners, theOddsApiData.awayCorners);
  merged.homeCards   = mergeBest(merged.homeCards,   theOddsApiData.homeCards);
  merged.awayCards   = mergeBest(merged.awayCards,   theOddsApiData.awayCards);
  merged.homeGoals   = mergeBest(merged.homeGoals,   theOddsApiData.homeGoals);
  merged.awayGoals   = mergeBest(merged.awayGoals,   theOddsApiData.awayGoals);

  // Player markets — merge each sub-bucket
  if (theOddsApiData.players || merged.players) {
    const mergedPlayers = { ...(merged.players || {}) };
    for (const k of ['scorer', 'shots', 'fouls', 'booked']) {
      const apiF = mergedPlayers[k];
      const odd  = theOddsApiData.players?.[k];
      const out  = mergeBest(apiF, odd);
      if (out) mergedPlayers[k] = out;
    }
    if (Object.keys(mergedPlayers).length > 0) merged.players = mergedPlayers;
  }

  // Drop empty markets so downstream consumers see them as missing
  for (const k of ['matchWinner', 'overUnder', 'btts', 'corners', 'cards',
                   'homeCorners', 'awayCorners', 'homeCards', 'awayCards',
                   'homeGoals', 'awayGoals']) {
    if (!merged[k] || Object.keys(merged[k]).length === 0) delete merged[k];
  }
  if (merged.players && Object.keys(merged.players).length === 0) delete merged.players;

  // Merge allBookmakerOdds — only allowed bookmakers (already filtered upstream)
  if (theOddsApiData.allBookmakerOdds?.length) {
    const existing = new Set((merged.allBookmakerOdds || []).map(b => normalizeBkName(b.name)));
    for (const bk of theOddsApiData.allBookmakerOdds) {
      if (!matchAllowedBookmaker(bk.name)) continue;
      if (!existing.has(normalizeBkName(bk.name))) {
        if (!merged.allBookmakerOdds) merged.allBookmakerOdds = [];
        merged.allBookmakerOdds.push(bk);
      }
    }
  }

  merged.oddsSource = 'merged';
  merged.allowedOnly = true;
  return merged;
}

// ===================== STANDINGS =====================

export async function getCachedStandingsPositions(leagueIds) {
  const positions = {};
  const results = await Promise.all(
    leagueIds.map(lid => {
      const season = currentSeason(lid);
      return getCachedEndpoint(`standings-${lid}-${season}`).catch(() => null);
    })
  );
  results.forEach(cached => {
    if (cached?.[0]?.league?.standings) {
      const table = cached[0].league.standings.flat();
      for (const entry of table) {
        if (entry.team?.id) positions[entry.team.id] = entry.rank;
      }
    }
  });
  return positions;
}

// ===================== FETCH MATCH STATS (on-demand for finished matches) =====================

export async function fetchMatchStats(fixtureId) {
  const { response: data } = await apiCall(`/fixtures?id=${fixtureId}`);
  const match = data?.[0];
  if (!match) return null;

  const homeId = match.teams.home.id;
  const awayId = match.teams.away.id;
  const homeStats = (match.statistics || []).find(s => s.team?.id === homeId);
  const awayStats = (match.statistics || []).find(s => s.team?.id === awayId);

  const getVal = (teamStats, type) => {
    const stat = (teamStats?.statistics || []).find(s => s.type === type);
    return stat?.value || 0;
  };

  const goalScorers = [], cardEvents = [], missedPenalties = [];
  for (const ev of (match.events || [])) {
    if (ev.type === 'Goal') {
      if (ev.detail === 'Missed Penalty') {
        missedPenalties.push({ player: ev.player?.name, teamId: ev.team?.id, minute: ev.time?.elapsed, extra: ev.time?.extra });
      } else {
        goalScorers.push({ player: ev.player?.name, teamId: ev.team?.id, minute: ev.time?.elapsed, extra: ev.time?.extra, type: ev.detail });
      }
    }
    if (ev.type === 'Card') {
      cardEvents.push({ player: ev.player?.name, teamId: ev.team?.id, minute: ev.time?.elapsed, type: ev.detail });
    }
  }

  const hCorners = getVal(homeStats, 'Corner Kicks');
  const aCorners = getVal(awayStats, 'Corner Kicks');
  const hYellow = getVal(homeStats, 'Yellow Cards') || cardEvents.filter(e => e.teamId === homeId && e.type === 'Yellow Card').length;
  const aYellow = getVal(awayStats, 'Yellow Cards') || cardEvents.filter(e => e.teamId === awayId && e.type === 'Yellow Card').length;
  const hRed = getVal(homeStats, 'Red Cards') || cardEvents.filter(e => e.teamId === homeId && (e.type === 'Red Card' || e.type === 'Second Yellow card')).length;
  const aRed = getVal(awayStats, 'Red Cards') || cardEvents.filter(e => e.teamId === awayId && (e.type === 'Red Card' || e.type === 'Second Yellow card')).length;

  return {
    fixtureId: match.fixture.id,
    status: match.fixture.status,
    goals: match.goals,
    score: match.score,
    corners: { home: hCorners, away: aCorners, total: hCorners + aCorners },
    yellowCards: { home: hYellow, away: aYellow, total: hYellow + aYellow },
    redCards: { home: hRed, away: aRed, total: hRed + aRed },
    goalScorers,
    cardEvents,
    missedPenalties,
    savedAt: new Date().toISOString(),
  };
}

// ===================== PREDICTION SNAPSHOT =====================

/**
 * Save a prediction snapshot to match_predictions at analysis time.
 * The finalize cron will later fill actual_* columns to enable calibration.
 * Fire-and-forget — never blocks analysis flow.
 */
async function _savePrediction(analysis, probs) {
  try {
    const { supabaseAdmin } = await import('./supabase');
    const w  = probs.winner   || {};
    const ou = probs.overUnder || {};
    const ca = probs.cards     || {};
    const fg = probs.firstGoal || {};

    // Top-N goleadores predichos a partir de playerHighlights (frecuencia histórica)
    const ph = analysis.playerHighlights || {};
    const predictedScorers = (ph.scorers || []).slice(0, 5).map(s => {
      const matchesWithGoal = (s.goals || []).filter(g => g >= 1).length;
      const totalMatches = (s.goals || []).length || 5;
      return {
        id: s.id,
        name: s.name,
        team: s.team,
        prob_pct: Math.round((matchesWithGoal / totalMatches) * 100),
      };
    });

    await supabaseAdmin.from('match_predictions').upsert({
      fixture_id:      analysis.fixtureId,
      date:            analysis.date,
      league_id:       analysis.leagueId,
      league_name:     analysis.league,
      home_team:       { id: analysis.homeId,  name: analysis.homeTeam, logo: analysis.homeLogo },
      away_team:       { id: analysis.awayId,  name: analysis.awayTeam, logo: analysis.awayLogo },
      kickoff:         analysis.kickoff,
      lambda_home:     probs.lambdaHome ?? null,
      lambda_away:     probs.lambdaAway ?? null,
      p_home_win:      w.home  ?? null,
      p_draw:          w.draw  ?? null,
      p_away_win:      w.away  ?? null,
      p_btts:          probs.btts ?? null,
      p_over_15:       ou.over15  ?? null,
      p_over_25:       ou.over25  ?? null,
      p_over_35:       ou.over35  ?? null,
      p_corners_over_85:  probs.corners?.over85  ?? null,
      p_corners_over_95:  probs.corners?.over95  ?? null,
      p_cards_over_25:    ca.over25 ?? null,
      p_cards_over_35:    ca.over35 ?? null,
      p_cards_over_45:    ca.over45 ?? null,
      p_first_goal_30:    fg.before30 ?? null,
      p_first_goal_45:    fg.before45 ?? null,
      predicted_scorers:  predictedScorers.length ? predictedScorers : null,
      home_position:   analysis.homePosition ?? null,
      away_position:   analysis.awayPosition ?? null,
      model_version:   probs.model_version || 'dc-v1',
    }, { onConflict: 'fixture_id' });
  } catch (e) {
    console.error('[PREDICTION] Save failed:', e.message);
  }
}

// ===================== HIDDEN MATCHES (legacy stubs — now handled per-user in Supabase) =====================

export async function getHiddenMatches() { return []; }
export async function hideMatch() { return []; }
export async function unhideMatch() { return []; }
