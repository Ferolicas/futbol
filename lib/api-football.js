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

async function apiCall(endpoint) {
  const key = getApiKey();
  if (!key) throw new Error('No API key configured');

  // No artificial daily limit — let API-Football enforce its own limits via HTTP 429.

  const res = await fetch(`https://${API_HOST}${endpoint}`, {
    headers: { 'x-apisports-key': key },
    cache: 'no-store',
  });

  if (!res.ok) {
    if (res.status === 429) throw new Error('RATE_LIMIT');
    throw new Error(`API error: ${res.status}`);
  }

  const data = await res.json();

  if (data.errors && Object.keys(data.errors).length > 0) {
    const errMsg = Object.values(data.errors).join('; ');
    throw new Error(`API: ${errMsg}`);
  }

  await incrementApiCallCount();

  // Return remaining from header if available
  const remaining = res.headers.get('x-ratelimit-requests-remaining');

  return { response: data.response || [], remaining: remaining ? parseInt(remaining) : null };
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

  // If not enough, try previous season
  if (finished.length < 5) {
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

  return finished.slice(0, 5);
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

  // 10. Match statistics for last 5 of each team (corners, cards)
  const homeFixtureIds = (results.homeLastFive || []).map(f => f.fixture?.id).filter(Boolean);
  const awayFixtureIds = (results.awayLastFive || []).map(f => f.fixture?.id).filter(Boolean);
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
    homeStats: null, // Derived from last 5 matches, not season endpoint
    awayStats: null, // Derived from last 5 matches, not season endpoint
    injuries: results.injuries || [],
    filteredInjuries,
    homeUsualXI,
    awayUsualXI,
    lineups: results.lineups || { available: false, data: [] },
    odds: mergeOdds(extractOdds(results.odds), results.theOddsApiData),
    cornerCardData,
    playerHighlights,
    goalTimingData,
  };

  // Compute probabilities server-side and include in analysis
  const { computeAllProbabilities } = await import('./calculations');
  const calculatedProbabilities = computeAllProbabilities(analysis);
  analysis.calculatedProbabilities = calculatedProbabilities;

  // Compute combinada server-side
  const { buildCombinada } = await import('./combinada');
  const teamNames = { home: analysis.homeTeam, away: analysis.awayTeam };
  analysis.combinada = buildCombinada(calculatedProbabilities, analysis.odds, analysis.playerHighlights, teamNames);

  // ===== STANDINGS POSITIONS =====
  // Try cached standings first, then fetch from API if not cached
  let homePosition = null;
  let awayPosition = null;
  try {
    const leagueId = fixture.league.id;
    const cachedPositions = await getCachedStandingsPositions([leagueId]);
    if (cachedPositions[homeId]) {
      homePosition = cachedPositions[homeId];
    }
    if (cachedPositions[awayId]) {
      awayPosition = cachedPositions[awayId];
    }
    // If not in cache, fetch standings from API
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
  analysis.homePosition = homePosition;
  analysis.awayPosition = awayPosition;

  // Save to Redis + Supabase
  await cacheAnalysis(fixtureId, analysis).catch(e => console.error(`[ANALYSIS] cache save failed ${fixtureId}:`, e.message));

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
              totalShots: 0,
              totalGoals: 0,
            };
          }

          const shots = p.statistics?.[0]?.shots?.on || 0;
          const goals = p.statistics?.[0]?.goals?.total || 0;

          playerMap[pid].shotsOnGoal.push(shots);
          playerMap[pid].goals.push(goals);
          playerMap[pid].totalShots += shots;
          playerMap[pid].totalGoals += goals;
        });
      });
    });
  };

  processTeamFixtures(homeFixtureIds, homeId, homeTeamName);
  processTeamFixtures(awayFixtureIds, awayId, awayTeamName);

  const allPlayers = Object.values(playerMap);

  // Consistent shooters: at least 1 shot on target in 4+ of last 5 matches
  const shooters = allPlayers
    .filter(p => p.shotsOnGoal.filter(s => s >= 1).length >= 4)
    .sort((a, b) => b.totalShots - a.totalShots)
    .slice(0, 8);

  // Scorers in streak: at least 1 goal in 3+ of last 5 matches
  const scorers = allPlayers
    .filter(p => p.goals.filter(g => g >= 1).length >= 3)
    .sort((a, b) => b.totalGoals - a.totalGoals)
    .slice(0, 8);

  return { shooters, scorers };
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

function extractOdds(oddsData) {
  if (!oddsData || !Array.isArray(oddsData) || oddsData.length === 0) return null;

  const bookmakers = oddsData[0]?.bookmakers || [];
  if (bookmakers.length === 0) return null;

  // Priority order for bookmakers — bwin first per user requirement
  const preferred = ['bwin', 'bet365', 'pinnacle', '1xbet', 'william hill'];
  const findBk = () => {
    for (const name of preferred) {
      const found = bookmakers.find(b => b.name?.toLowerCase().includes(name));
      if (found) return found;
    }
    return bookmakers[0];
  };

  // Find specific bet type across ALL bookmakers (fallback search)
  const findBet = (betName) => {
    for (const bk of bookmakers) {
      const bet = (bk.bets || []).find(b => b.name === betName);
      if (bet && bet.values?.length > 0) return { bet, bookmaker: bk.name };
    }
    return null;
  };

  const mainBk = findBk();
  const result = {};

  // Match Winner — from preferred bookmaker
  const mwBet = (mainBk.bets || []).find(b => b.name === 'Match Winner');
  if (mwBet) {
    result.matchWinner = {};
    for (const v of mwBet.values || []) {
      if (v.value === 'Home') result.matchWinner.home = parseFloat(v.odd);
      if (v.value === 'Draw') result.matchWinner.draw = parseFloat(v.odd);
      if (v.value === 'Away') result.matchWinner.away = parseFloat(v.odd);
    }
  }

  // Goals Over/Under — search all bookmakers if not in preferred
  const ouResult = findBet('Goals Over/Under');
  if (ouResult) {
    result.overUnder = {};
    for (const v of ouResult.bet.values || []) {
      // Sanitize key for Sanity compatibility: "Over 1.5" → "Over_1_5"
      const key = v.value.replace(/[^a-zA-Z0-9_-]/g, '_');
      result.overUnder[key] = parseFloat(v.odd);
    }
  }

  // Both Teams Score — search all bookmakers if needed
  const bttsResult = findBet('Both Teams Score');
  if (bttsResult) {
    result.btts = {};
    for (const v of bttsResult.bet.values || []) {
      result.btts[v.value.toLowerCase()] = parseFloat(v.odd);
    }
  }

  // Corners Over/Under — search multiple possible bet names
  const cornerNames = ['Total - Corners', 'Corners Over Under', 'Total Corners'];
  let cornerResult = null;
  for (const name of cornerNames) {
    cornerResult = findBet(name);
    if (cornerResult) break;
  }
  if (!cornerResult) {
    for (const bk of bookmakers) {
      const bet = (bk.bets || []).find(b => b.name?.toLowerCase().includes('corner'));
      if (bet && bet.values?.length > 0) { cornerResult = { bet, bookmaker: bk.name }; break; }
    }
  }
  if (cornerResult) {
    result.corners = {};
    for (const v of cornerResult.bet.values || []) {
      const key = v.value.replace(/[^a-zA-Z0-9_-]/g, '_');
      result.corners[key] = parseFloat(v.odd);
    }
  }

  // Cards Over/Under — search multiple possible bet names
  const cardNames = ['Total - Cards', 'Cards Over Under', 'Total Cards'];
  let cardResult = null;
  for (const name of cardNames) {
    cardResult = findBet(name);
    if (cardResult) break;
  }
  if (!cardResult) {
    for (const bk of bookmakers) {
      const bet = (bk.bets || []).find(b => b.name?.toLowerCase().includes('card'));
      if (bet && bet.values?.length > 0) { cardResult = { bet, bookmaker: bk.name }; break; }
    }
  }
  if (cardResult) {
    result.cards = {};
    for (const v of cardResult.bet.values || []) {
      const key = v.value.replace(/[^a-zA-Z0-9_-]/g, '_');
      result.cards[key] = parseFloat(v.odd);
    }
  }

  result.bookmaker = mainBk.name;

  // Extract odds from ALL bookmakers for country-based selection
  result.allBookmakerOdds = bookmakers.map(bk => {
    const entry = { id: bk.id, name: bk.name };

    const bkMW = (bk.bets || []).find(b => b.name === 'Match Winner');
    if (bkMW) {
      entry.matchWinner = {};
      for (const v of bkMW.values || []) {
        if (v.value === 'Home') entry.matchWinner.home = parseFloat(v.odd);
        if (v.value === 'Draw') entry.matchWinner.draw = parseFloat(v.odd);
        if (v.value === 'Away') entry.matchWinner.away = parseFloat(v.odd);
      }
    }

    const bkOU = (bk.bets || []).find(b => b.name === 'Goals Over/Under');
    if (bkOU) {
      entry.overUnder = {};
      for (const v of bkOU.values || []) {
        const key = v.value.replace(/[^a-zA-Z0-9_-]/g, '_');
        entry.overUnder[key] = parseFloat(v.odd);
      }
    }

    const bkBTTS = (bk.bets || []).find(b => b.name === 'Both Teams Score');
    if (bkBTTS) {
      entry.btts = {};
      for (const v of bkBTTS.values || []) {
        entry.btts[v.value.toLowerCase()] = parseFloat(v.odd);
      }
    }

    const bkCorners = (bk.bets || []).find(b =>
      b.name === 'Total - Corners' || b.name === 'Corners Over Under' || b.name === 'Total Corners' ||
      b.name?.toLowerCase().includes('corner')
    );
    if (bkCorners) {
      entry.corners = {};
      for (const v of bkCorners.values || []) {
        const key = v.value.replace(/[^a-zA-Z0-9_-]/g, '_');
        entry.corners[key] = parseFloat(v.odd);
      }
    }

    const bkCards = (bk.bets || []).find(b =>
      b.name === 'Total - Cards' || b.name === 'Cards Over Under' || b.name === 'Total Cards' ||
      b.name?.toLowerCase().includes('card')
    );
    if (bkCards) {
      entry.cards = {};
      for (const v of bkCards.values || []) {
        const key = v.value.replace(/[^a-zA-Z0-9_-]/g, '_');
        entry.cards[key] = parseFloat(v.odd);
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
  // If no API-Football odds but The Odds API has data, use it
  if (!apiFootballOdds && theOddsApiData) {
    return theOddsApiData;
  }

  // If no The Odds API data, return API-Football odds as-is
  if (!theOddsApiData || !apiFootballOdds) {
    return apiFootballOdds;
  }

  // Merge: fill missing markets from The Odds API
  const merged = { ...apiFootballOdds };

  if (!merged.matchWinner && theOddsApiData.matchWinner) {
    merged.matchWinner = theOddsApiData.matchWinner;
  }
  if (!merged.overUnder && theOddsApiData.overUnder) {
    merged.overUnder = theOddsApiData.overUnder;
  }

  // Merge allBookmakerOdds arrays (add The Odds API bookmakers)
  if (theOddsApiData.allBookmakerOdds?.length) {
    const existing = new Set(
      (merged.allBookmakerOdds || []).map(b => b.name?.toLowerCase())
    );
    for (const bk of theOddsApiData.allBookmakerOdds) {
      if (!existing.has(bk.name?.toLowerCase())) {
        if (!merged.allBookmakerOdds) merged.allBookmakerOdds = [];
        merged.allBookmakerOdds.push(bk);
      }
    }
  }

  // Add source marker
  merged.oddsSource = 'merged';

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

// ===================== HIDDEN MATCHES (legacy stubs — now handled per-user in Supabase) =====================

export async function getHiddenMatches() { return []; }
export async function hideMatch() { return []; }
export async function unhideMatch() { return []; }
