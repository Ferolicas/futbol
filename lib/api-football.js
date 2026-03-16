import { ALL_LEAGUE_IDS, LEAGUES } from './leagues';
import {
  getCachedFixtures, cacheFixtures,
  getCachedAnalysis, cacheAnalysis,
  getCachedEndpoint, cacheEndpoint,
  incrementApiCallCount, getApiCallCount,
  markAsAnalyzed,
} from './sanity-cache';

const API_HOST = 'v3.football.api-sports.io';
const DAILY_LIMIT = 100;

// ===================== CORE =====================

function getApiKey() {
  return process.env.FOOTBALL_API_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || null;
}

function currentSeason() {
  const now = new Date();
  const computed = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  // Free plan only supports seasons 2022-2024
  return Math.min(computed, 2024);
}

async function apiCall(endpoint) {
  const key = getApiKey();
  if (!key) throw new Error('No API key configured');

  const count = await getApiCallCount();
  if (count >= DAILY_LIMIT) throw new Error('RATE_LIMIT');

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
    if (errMsg.toLowerCase().includes('rate') || errMsg.toLowerCase().includes('limit')) {
      throw new Error('RATE_LIMIT');
    }
    throw new Error(`API: ${errMsg}`);
  }

  await incrementApiCallCount();

  // Return remaining from header if available
  const remaining = res.headers.get('x-ratelimit-requests-remaining');

  return { response: data.response || [], remaining: remaining ? parseInt(remaining) : null };
}

// Cached API call — checks Sanity first
async function cachedApiCall(cacheKey, endpoint) {
  const cached = await getCachedEndpoint(cacheKey);
  // Don't return cached empty arrays — they likely represent previous failed/empty fetches
  if (cached !== null && !(Array.isArray(cached) && cached.length === 0)) {
    return { data: cached, fromCache: true };
  }

  try {
    const { response: data } = await apiCall(endpoint);
    // Only cache non-empty results
    if (!Array.isArray(data) || data.length > 0) {
      await cacheEndpoint(cacheKey, data);
    }
    return { data, fromCache: false };
  } catch (e) {
    if (e.message === 'RATE_LIMIT') {
      const { getFromSanity } = await import('./sanity');
      const doc = await getFromSanity('apiCache', cacheKey);
      if (doc?.data) return { data: doc.data, fromCache: true, stale: true };
    }
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
    // Fallback to cache on error
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
    remaining: Math.max(0, DAILY_LIMIT - count),
    limit: DAILY_LIMIT,
    date: new Date().toISOString().split('T')[0],
  };
}

// ===================== FIXTURES =====================

export async function getFixtures(date) {
  const cached = await getCachedFixtures(date);
  if (cached) {
    return { fixtures: cached, fromCache: true };
  }

  try {
    const { response: all } = await apiCall(`/fixtures?date=${date}`);
    const filtered = all
      .filter(m => ALL_LEAGUE_IDS.includes(m.league.id))
      .map(m => ({
        ...m,
        leagueMeta: LEAGUES[m.league.id] || { country: m.league.country, name: m.league.name, division: 0, gender: 'M' },
      }));

    if (filtered.length > 0) {
      await cacheFixtures(date, filtered);
    }

    return { fixtures: filtered, fromCache: false };
  } catch (e) {
    const { getFromSanity } = await import('./sanity');
    const doc = await getFromSanity('footballFixturesCache', date);
    if (doc?.fixtures) {
      return { fixtures: doc.fixtures, fromCache: true, stale: true };
    }
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

export async function analyzeMatch(fixture) {
  const fixtureId = fixture.fixture.id;
  const homeId = fixture.teams.home.id;
  const awayId = fixture.teams.away.id;
  const homeLeagueId = fixture.league.id;
  const date = new Date().toISOString().split('T')[0];

  // Check if already analyzed today
  const existing = await getCachedAnalysis(fixtureId);
  if (existing) return { analysis: existing, fromCache: true, apiCalls: 0 };

  let apiCalls = 0;
  const results = {};

  const todayStr = new Date().toISOString().split('T')[0];
  const finishedStatuses = ['FT', 'AET', 'PEN'];
  // Free plan max season: 2024. Try that first, fallback to 2023.
  const maxSeason = 2024;

  // 1. H2H (no &last param — free plan doesn't support it)
  try {
    const { data, fromCache } = await cachedApiCall(
      `h2h-${homeId}-${awayId}-v2`,
      `/fixtures/headtohead?h2h=${homeId}-${awayId}`
    );
    // Filter finished matches only, then take last 5
    results.h2h = (data || [])
      .filter(f => finishedStatuses.includes(f.fixture?.status?.short))
      .slice(-5);
    if (!fromCache) apiCalls++;
    console.log(`[ANALYSIS] H2H ${homeId}-${awayId}: ${results.h2h.length} results (of ${(data||[]).length} total), fromCache=${fromCache}`);
  } catch (e) { console.log(`[ANALYSIS] H2H ERROR: ${e.message}`); results.h2h = []; }

  // 2. Home last 5 (use season 2024 — max available on free plan)
  results.homeLastFive = await fetchLast5(homeId, maxSeason, finishedStatuses);
  console.log(`[ANALYSIS] Home last5 (${homeId}): ${results.homeLastFive.length} matches`);

  // 3. Away last 5
  results.awayLastFive = await fetchLast5(awayId, maxSeason, finishedStatuses);
  console.log(`[ANALYSIS] Away last5 (${awayId}): ${results.awayLastFive.length} matches`);

  // 4-5. REMOVED: Team season stats — not available on free plan for current season
  // All stats are derived from per-fixture data (last 5 matches) instead

  // 6. Injuries
  try {
    const { data, fromCache } = await cachedApiCall(
      `injuries-${fixtureId}`,
      `/injuries?fixture=${fixtureId}`
    );
    results.injuries = data;
    if (!fromCache) apiCalls++;
  } catch { results.injuries = []; }

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
  } catch { results.lineups = { available: false, data: [] }; }

  // 8. Odds
  try {
    const { data, fromCache } = await cachedApiCall(
      `odds-${fixtureId}`,
      `/odds?fixture=${fixtureId}`
    );
    results.odds = data;
    if (!fromCache) apiCalls++;
  } catch { results.odds = []; }

  // 9-10. REMOVED: Season player stats — not available on free plan for current season
  // Usual XI is derived from per-fixture player data instead

  // 10. Match statistics for last 5 of each team (corners, cards)
  const homeFixtureIds = (results.homeLastFive || []).map(f => f.fixture?.id).filter(Boolean);
  const awayFixtureIds = (results.awayLastFive || []).map(f => f.fixture?.id).filter(Boolean);
  const uniqueFixtureIds = [...new Set([...homeFixtureIds, ...awayFixtureIds])];

  // 10-11. Fetch match stats AND players in parallel for all fixtures
  const matchStatsMap = {};
  const matchPlayersMap = {};
  await Promise.all(uniqueFixtureIds.map(async (fid) => {
    const [statsResult, playersResult] = await Promise.allSettled([
      cachedApiCall(`matchstats-${fid}`, `/fixtures/statistics?fixture=${fid}`),
      cachedApiCall(`matchplayers-${fid}`, `/fixtures/players?fixture=${fid}`),
    ]);
    matchStatsMap[fid] = statsResult.status === 'fulfilled' ? statsResult.value.data : [];
    if (statsResult.status === 'fulfilled' && !statsResult.value.fromCache) apiCalls++;
    matchPlayersMap[fid] = playersResult.status === 'fulfilled' ? playersResult.value.data : [];
    if (playersResult.status === 'fulfilled' && !playersResult.value.fromCache) apiCalls++;
  }));

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
    status: fixture.fixture.status,
    goals: fixture.goals,
    h2h: results.h2h || [],
    homeLastFive: results.homeLastFive || [],
    awayLastFive: results.awayLastFive || [],
    homeStats: null, // Derived from last 5 matches, not season endpoint
    awayStats: null, // Derived from last 5 matches, not season endpoint
    injuries: results.injuries || [],
    filteredInjuries,
    homeUsualXI,
    awayUsualXI,
    lineups: results.lineups || { available: false, data: [] },
    odds: extractOdds(results.odds),
    cornerCardData,
    playerHighlights,
  };

  // Compute probabilities server-side and include in analysis
  const { computeAllProbabilities } = await import('./calculations');
  const calculatedProbabilities = computeAllProbabilities(analysis);
  analysis.calculatedProbabilities = calculatedProbabilities;

  // Compute combinada server-side
  const { buildCombinada } = await import('./combinada');
  analysis.combinada = buildCombinada(calculatedProbabilities, analysis.odds, analysis.playerHighlights);

  // Standings not available on free plan for current season
  analysis.homePosition = null;
  analysis.awayPosition = null;

  // Save to Sanity
  await cacheAnalysis(fixtureId, analysis);
  await markAsAnalyzed(date, fixtureId);

  return { analysis, fromCache: false, apiCalls };
}

// ===================== REFRESH LINEUPS =====================

export async function refreshLineups(fixtureId) {
  try {
    const { response: data } = await apiCall(`/fixtures/lineups?fixture=${fixtureId}`);
    const lineups = data && data.length > 0
      ? { available: true, data }
      : { available: false, data: [] };
    await cacheEndpoint(`lineups-${fixtureId}`, data);
    return lineups;
  } catch {
    return { available: false, data: [] };
  }
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
        if (isHome) {
          homeCornersFor += teamCorners;
          homeCornersAgainst += oppCorners;
          homeCornerMatches++;
        } else {
          awayCornersFor += teamCorners;
          awayCornersAgainst += oppCorners;
          awayCornerMatches++;
        }
      }

      if (foundCard) {
        if (isHome) {
          homeYellows += teamYellow;
          homeReds += teamRed;
          homeCardMatches++;
        } else {
          awayYellows += teamYellow;
          awayReds += teamRed;
          awayCardMatches++;
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

  // Consistent shooters: at least 1 shot on target in 3+ of last 5 matches
  const shooters = allPlayers
    .filter(p => p.shotsOnGoal.filter(s => s >= 1).length >= 3)
    .sort((a, b) => b.totalShots - a.totalShots)
    .slice(0, 8);

  // Scorers in streak: at least 1 goal in 3+ of last 5 matches
  const scorers = allPlayers
    .filter(p => p.goals.filter(g => g >= 1).length >= 3)
    .sort((a, b) => b.totalGoals - a.totalGoals)
    .slice(0, 8);

  return { shooters, scorers };
}

// ===================== HELPERS =====================

function extractOdds(oddsData) {
  if (!oddsData || !Array.isArray(oddsData) || oddsData.length === 0) return null;

  const bookmakers = oddsData[0]?.bookmakers || [];
  if (bookmakers.length === 0) return null;

  // Priority order for bookmakers
  const preferred = ['bet365', 'bwin', 'pinnacle', '1xbet', 'william hill'];
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
      const key = v.value.replace(/\s+/g, '_').replace(/\./g, '_');
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

  result.bookmaker = mainBk.name;
  return result;
}

// ===================== STANDINGS =====================

export async function getCachedStandingsPositions(leagueIds) {
  const positions = {};
  const season = currentSeason();
  const results = await Promise.all(
    leagueIds.map(lid => getCachedEndpoint(`standings-${lid}-${season}`).catch(() => null))
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

// ===================== HIDDEN MATCHES =====================

export async function getHiddenMatches() {
  const { getFromSanity } = await import('./sanity');
  const doc = await getFromSanity('appConfig', 'hiddenMatches');
  return doc?.fixtureIds || [];
}

export async function hideMatch(fixtureId) {
  const { saveToSanity } = await import('./sanity');
  const current = await getHiddenMatches();
  if (!current.includes(fixtureId)) current.push(fixtureId);
  await saveToSanity('appConfig', 'hiddenMatches', { fixtureIds: current, updatedAt: new Date().toISOString() });
  return current;
}

export async function unhideMatch(fixtureId) {
  const { saveToSanity } = await import('./sanity');
  const current = await getHiddenMatches();
  const updated = current.filter(id => id !== fixtureId);
  await saveToSanity('appConfig', 'hiddenMatches', { fixtureIds: updated, updatedAt: new Date().toISOString() });
  return updated;
}
