import { ALL_LEAGUE_IDS, LEAGUES, getCountryLeagueIds } from './leagues';
import { getFromSanity, saveToSanity, queryFromSanity } from './sanity';

const API_HOST = 'v3.football.api-sports.io';
const DAILY_LIMIT = 100;
const CALLS_PER_ANALYSIS = 5; // 2 team stats + h2h + odds + injuries

// ===================== API QUOTA TRACKING =====================

function todayKey() {
  return new Date().toISOString().split('T')[0];
}

export async function getQuota() {
  const key = todayKey();
  const doc = await getFromSanity('appConfig', `apiQuota-${key}`);
  const used = doc?.used || 0;
  return { used, remaining: Math.max(0, DAILY_LIMIT - used), limit: DAILY_LIMIT, date: key };
}

async function trackCalls(count) {
  const key = todayKey();
  const doc = await getFromSanity('appConfig', `apiQuota-${key}`);
  const used = (doc?.used || 0) + count;
  await saveToSanity('appConfig', `apiQuota-${key}`, { date: key, used, updatedAt: new Date().toISOString() });
  return used;
}

// ===================== CORE API CALL =====================

async function apiCall(endpoint, apiKey) {
  const res = await fetch(`https://${API_HOST}${endpoint}`, {
    headers: { 'x-apisports-key': apiKey },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    console.error('API-Football errors:', data.errors);
  }
  return data.response;
}

// Tracked API call - counts towards daily quota
async function trackedApiCall(endpoint, apiKey) {
  const result = await apiCall(endpoint, apiKey);
  await trackCalls(1);
  return result;
}

// Safe tracked API call that never throws
async function safeTrackedCall(endpoint, apiKey, fallback) {
  try {
    const result = await trackedApiCall(endpoint, apiKey);
    return result ?? fallback;
  } catch (e) {
    console.error(`API call failed ${endpoint}:`, e.message);
    return fallback;
  }
}

function getSeason(date, country) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const european = ['Germany', 'Spain', 'England', 'Italy', 'Turkey', 'France', 'Saudi Arabia'];
  if (european.includes(country)) {
    return month >= 7 ? year : year - 1;
  }
  return year;
}

// ===================== MATCHES =====================

export async function getMatches(date, apiKey) {
  const cached = await getFromSanity('matchDay', date);
  if (cached && cached.matches && cached.matches.length > 0) {
    const cacheAge = Date.now() - new Date(cached.fetchedAt).getTime();
    const hasLive = cached.matches.some(m =>
      ['1H', '2H', 'HT', 'ET', 'P'].includes(m.fixture?.status?.short)
    );
    if ((!hasLive && cacheAge < 6 * 60 * 60 * 1000) || (hasLive && cacheAge < 2 * 60 * 1000)) {
      const quota = await getQuota();
      return { matches: cached.matches, fromCache: true, apiCalls: 0, quota };
    }
  }

  const allFixtures = await trackedApiCall(`/fixtures?date=${date}`, apiKey);
  const quota = await getQuota();
  if (!allFixtures) return { matches: [], fromCache: false, apiCalls: 1, quota };

  const filtered = allFixtures.filter(m => ALL_LEAGUE_IDS.includes(m.league.id));

  const enriched = filtered.map(m => ({
    ...m,
    leagueMeta: LEAGUES[m.league.id] || { country: m.league.country, name: m.league.name, division: 0, gender: 'M' },
  }));

  await saveToSanity('matchDay', date, {
    date,
    matches: enriched,
    fetchedAt: new Date().toISOString(),
    matchCount: enriched.length,
  });

  return { matches: enriched, fromCache: false, apiCalls: 1, quota };
}

// ===================== ANALYSIS (OPTIMIZED) =====================

export async function analyzeMatch(fixtureId, homeId, awayId, leagueId, season, date, apiKey) {
  // Check cache - only use if stats actually exist
  const cached = await getFromSanity('matchAnalysis', String(fixtureId));
  if (cached && cached.homeStats && cached.homeStats.form && cached.awayStats && cached.awayStats.form) {
    return { analysis: cached, fromCache: true, apiCalls: 0 };
  }

  // Check quota BEFORE making calls
  const quota = await getQuota();
  if (quota.remaining < CALLS_PER_ANALYSIS) {
    return {
      analysis: { fixtureId, error: `Limite API alcanzado (${quota.used}/${quota.limit}). Intenta manana.` },
      fromCache: false,
      apiCalls: 0,
      quotaExceeded: true,
    };
  }

  const leagueMeta = LEAGUES[leagueId];
  const country = leagueMeta?.country || '';
  const primaryLeagueIds = getCountryLeagueIds(country);
  const effectiveSeason = season || getSeason(date || new Date().toISOString().split('T')[0], country);

  // Fetch all data in parallel - OPTIMIZED: max 1 call per team stats
  const [homeStats, awayStats, h2h, odds, injuries] = await Promise.all([
    fetchTeamStatsOptimized(homeId, leagueId, primaryLeagueIds, effectiveSeason, apiKey),
    fetchTeamStatsOptimized(awayId, leagueId, primaryLeagueIds, effectiveSeason, apiKey),
    safeTrackedCall(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`, apiKey, []),
    safeTrackedCall(`/odds?fixture=${fixtureId}`, apiKey, []).then(r => (Array.isArray(r) ? r[0] : r) || null),
    safeTrackedCall(`/injuries?fixture=${fixtureId}`, apiKey, []),
  ]);

  const homeFormPts = calcFormPoints(homeStats?.form);
  const awayFormPts = calcFormPoints(awayStats?.form);
  const betterForm = homeFormPts > awayFormPts ? 'home' : awayFormPts > homeFormPts ? 'away' : 'equal';

  const analysis = {
    fixtureId,
    date: date || new Date().toISOString().split('T')[0],
    homeStats: homeStats || null,
    awayStats: awayStats || null,
    h2h: Array.isArray(h2h) ? h2h : [],
    odds: odds || null,
    injuries: Array.isArray(injuries) ? injuries : [],
    betterForm,
    fetchedAt: new Date().toISOString(),
  };

  await saveToSanity('matchAnalysis', String(fixtureId), analysis);

  return { analysis, fromCache: false, apiCalls: CALLS_PER_ANALYSIS };
}

// OPTIMIZED: Max 1 API call per team (pick best league, single season only)
async function fetchTeamStatsOptimized(teamId, matchLeagueId, primaryLeagueIds, season, apiKey) {
  const leagueMeta = LEAGUES[matchLeagueId];
  const isDivisionLeague = leagueMeta && (leagueMeta.division === 1 || leagueMeta.division === 2);

  // Pick ONE league to query - the most likely to have data
  const leagueToUse = isDivisionLeague
    ? matchLeagueId
    : (primaryLeagueIds[0] || matchLeagueId); // For cups, use primary division 1

  try {
    const result = await trackedApiCall(
      `/teams/statistics?team=${teamId}&season=${season}&league=${leagueToUse}`,
      apiKey
    );
    if (result && typeof result === 'object' && !Array.isArray(result) && result.form) {
      return result;
    }
  } catch (e) {
    console.error(`Stats failed team=${teamId} league=${leagueToUse} season=${season}:`, e.message);
  }

  return null;
}

function calcFormPoints(form) {
  if (!form) return 0;
  return form.split('').reduce((acc, l) => {
    if (l === 'W') return acc + 3;
    if (l === 'D') return acc + 1;
    return acc;
  }, 0);
}

// ===================== HIDDEN MATCHES =====================

export async function getHiddenMatches() {
  const doc = await getFromSanity('appConfig', 'hiddenMatches');
  return doc?.fixtureIds || [];
}

export async function hideMatch(fixtureId) {
  const current = await getHiddenMatches();
  if (!current.includes(fixtureId)) current.push(fixtureId);
  await saveToSanity('appConfig', 'hiddenMatches', { fixtureIds: current, updatedAt: new Date().toISOString() });
  return current;
}

export async function unhideMatch(fixtureId) {
  const current = await getHiddenMatches();
  const updated = current.filter(id => id !== fixtureId);
  await saveToSanity('appConfig', 'hiddenMatches', { fixtureIds: updated, updatedAt: new Date().toISOString() });
  return updated;
}

// ===================== HISTORY =====================

export async function getAnalyzedMatches(date) {
  const query = `*[_type == "matchAnalysis" && date == $date]{
    fixtureId, date, homeStats, awayStats, h2h, odds, injuries, betterForm, fetchedAt
  }`;
  const results = await queryFromSanity(query, { date });
  return results || [];
}

export async function getAllAnalyzedDates() {
  const query = `*[_type == "matchAnalysis"] | order(date desc) {
    date
  }[0...100]`;
  const results = await queryFromSanity(query);
  if (!results) return [];
  const dates = [...new Set(results.map(r => r.date).filter(Boolean))];
  return dates;
}
