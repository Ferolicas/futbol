import { ALL_LEAGUE_IDS, LEAGUES, getCountryLeagueIds } from './leagues';
import { getFromSanity, saveToSanity, queryFromSanity } from './sanity';

const API_HOST = 'v3.football.api-sports.io';

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
      return { matches: cached.matches, fromCache: true, apiCalls: 0 };
    }
  }

  const allFixtures = await apiCall(`/fixtures?date=${date}`, apiKey);
  if (!allFixtures) return { matches: [], fromCache: false, apiCalls: 1 };

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

  return { matches: enriched, fromCache: false, apiCalls: 1 };
}

// ===================== ANALYSIS =====================

export async function analyzeMatch(fixtureId, homeId, awayId, leagueId, season, date, apiKey) {
  // Check cache - only use if stats actually exist
  const cached = await getFromSanity('matchAnalysis', String(fixtureId));
  if (cached && cached.homeStats && cached.homeStats.form && cached.awayStats && cached.awayStats.form) {
    return { analysis: cached, fromCache: true, apiCalls: 0 };
  }

  const leagueMeta = LEAGUES[leagueId];
  const country = leagueMeta?.country || '';
  const primaryLeagueIds = getCountryLeagueIds(country);
  const effectiveSeason = season || getSeason(date || new Date().toISOString().split('T')[0], country);

  // Fetch all data in parallel - each wrapped in its own error handler
  const [homeStats, awayStats, h2h, odds, injuries] = await Promise.all([
    fetchTeamStats(homeId, leagueId, primaryLeagueIds, effectiveSeason, apiKey),
    fetchTeamStats(awayId, leagueId, primaryLeagueIds, effectiveSeason, apiKey),
    safeApiCall(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`, apiKey, []),
    safeApiCall(`/odds?fixture=${fixtureId}`, apiKey, []).then(r => (Array.isArray(r) ? r[0] : r) || null),
    safeApiCall(`/injuries?fixture=${fixtureId}`, apiKey, []),
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

  return { analysis, fromCache: false, apiCalls: 5 };
}

// Safe API call that never throws
async function safeApiCall(endpoint, apiKey, fallback) {
  try {
    const result = await apiCall(endpoint, apiKey);
    return result ?? fallback;
  } catch (e) {
    console.error(`API call failed ${endpoint}:`, e.message);
    return fallback;
  }
}

async function fetchTeamStats(teamId, matchLeagueId, primaryLeagueIds, season, apiKey) {
  const leagueMeta = LEAGUES[matchLeagueId];
  const isDivisionLeague = leagueMeta && (leagueMeta.division === 1 || leagueMeta.division === 2);

  // Build ordered list of league IDs to try
  const leaguesToTry = [];

  if (isDivisionLeague) {
    leaguesToTry.push(matchLeagueId);
  }

  // Add primary leagues that aren't already in the list
  for (const lid of primaryLeagueIds) {
    if (!leaguesToTry.includes(lid)) {
      leaguesToTry.push(lid);
    }
  }

  // If it's a cup and match league not added yet, add it last
  if (!isDivisionLeague && !leaguesToTry.includes(matchLeagueId)) {
    leaguesToTry.push(matchLeagueId);
  }

  // Also try previous season if current fails
  const seasonsToTry = [season];
  if (season > 2020) seasonsToTry.push(season - 1);

  for (const s of seasonsToTry) {
    for (const lid of leaguesToTry) {
      try {
        const result = await apiCall(
          `/teams/statistics?team=${teamId}&season=${s}&league=${lid}`,
          apiKey
        );

        // API returns an object (not array) for this endpoint
        if (result && typeof result === 'object' && !Array.isArray(result) && result.form) {
          return result;
        }
      } catch (e) {
        console.error(`Stats failed team=${teamId} league=${lid} season=${s}:`, e.message);
        continue;
      }
    }
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

// ===================== LIVE SCORES =====================

export async function getLiveScores(date, apiKey) {
  const allFixtures = await apiCall(`/fixtures?date=${date}`, apiKey);
  if (!allFixtures) return { matches: [], apiCalls: 1 };

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

  return { matches: enriched, apiCalls: 1 };
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
  // Query Sanity for all analyses for a specific date
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
  // Unique dates
  const dates = [...new Set(results.map(r => r.date).filter(Boolean))];
  return dates;
}
