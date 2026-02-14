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
  return data.response || [];
}

// Determine correct season for a given date
function getSeason(date, country) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;

  // European leagues run Aug-May, South American Jan-Dec
  const european = ['Germany', 'Spain', 'England', 'Italy', 'Turkey', 'France', 'Saudi Arabia'];
  if (european.includes(country)) {
    return month >= 7 ? year : year - 1;
  }
  return year;
}

// ===================== MATCHES =====================

export async function getMatches(date, apiKey) {
  // Check Sanity cache first
  const cached = await getFromSanity('matchDay', date);
  if (cached && cached.matches && cached.matches.length > 0) {
    const cacheAge = Date.now() - new Date(cached.fetchedAt).getTime();
    const hasLive = cached.matches.some(m =>
      ['1H', '2H', 'HT', 'ET', 'P'].includes(m.fixture?.status?.short)
    );
    // Use cache if < 6 hours old (or < 2 min for live matches)
    if ((!hasLive && cacheAge < 6 * 60 * 60 * 1000) || (hasLive && cacheAge < 2 * 60 * 1000)) {
      return { matches: cached.matches, fromCache: true, apiCalls: 0 };
    }
  }

  // Fetch from API
  const allFixtures = await apiCall(`/fixtures?date=${date}`, apiKey);

  // Filter by our league IDs
  const filtered = allFixtures.filter(m => ALL_LEAGUE_IDS.includes(m.league.id));

  // Enrich with league metadata
  const enriched = filtered.map(m => ({
    ...m,
    leagueMeta: LEAGUES[m.league.id] || { country: m.league.country, name: m.league.name, division: 0, gender: 'M' },
  }));

  // Save to Sanity
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
  // Check Sanity cache
  const cached = await getFromSanity('matchAnalysis', String(fixtureId));
  if (cached && cached.homeStats && cached.awayStats) {
    return { analysis: cached, fromCache: true, apiCalls: 0 };
  }

  const leagueMeta = LEAGUES[leagueId];
  const country = leagueMeta?.country || '';

  // For cup matches, find the team's primary league
  const primaryLeagueIds = getCountryLeagueIds(country);
  const effectiveSeason = season || getSeason(date || new Date().toISOString().split('T')[0], country);

  // Fetch all data in parallel
  const [homeStats, awayStats, h2h, odds, injuries] = await Promise.all([
    fetchTeamStats(homeId, leagueId, primaryLeagueIds, effectiveSeason, apiKey),
    fetchTeamStats(awayId, leagueId, primaryLeagueIds, effectiveSeason, apiKey),
    apiCall(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`, apiKey),
    apiCall(`/odds?fixture=${fixtureId}`, apiKey).then(r => r[0] || null),
    apiCall(`/injuries?fixture=${fixtureId}`, apiKey),
  ]);

  // Calculate form points
  const homeFormPts = calcFormPoints(homeStats?.form);
  const awayFormPts = calcFormPoints(awayStats?.form);
  const betterForm = homeFormPts > awayFormPts ? 'home' : awayFormPts > homeFormPts ? 'away' : 'equal';

  const analysis = {
    fixtureId,
    homeStats,
    awayStats,
    h2h,
    odds,
    injuries,
    betterForm,
    fetchedAt: new Date().toISOString(),
  };

  // Save to Sanity
  await saveToSanity('matchAnalysis', String(fixtureId), analysis);

  // 5 API calls: 1 homeStats + 1 awayStats + 1 h2h + 1 odds + 1 injuries
  // (may be more if cup match requires fallback league lookup)
  return { analysis, fromCache: false, apiCalls: 5 };
}

async function fetchTeamStats(teamId, matchLeagueId, primaryLeagueIds, season, apiKey) {
  // First try with the match's league ID
  const leagueMeta = LEAGUES[matchLeagueId];
  const isDivisionLeague = leagueMeta && (leagueMeta.division === 1 || leagueMeta.division === 2);

  if (isDivisionLeague) {
    const stats = await apiCall(
      `/teams/statistics?team=${teamId}&season=${season}&league=${matchLeagueId}`,
      apiKey
    );
    if (stats && stats.form) return stats;
  }

  // For cup/supercup matches, try primary leagues (1st div, then 2nd div)
  for (const lid of primaryLeagueIds) {
    try {
      const stats = await apiCall(
        `/teams/statistics?team=${teamId}&season=${season}&league=${lid}`,
        apiKey
      );
      if (stats && stats.form) return stats;
    } catch {
      continue;
    }
  }

  // Fallback: try with match league anyway
  if (!isDivisionLeague) {
    try {
      const stats = await apiCall(
        `/teams/statistics?team=${teamId}&season=${season}&league=${matchLeagueId}`,
        apiKey
      );
      return stats || null;
    } catch {
      return null;
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
  // Always fetch fresh for live updates
  const allFixtures = await apiCall(`/fixtures?date=${date}`, apiKey);
  const filtered = allFixtures.filter(m => ALL_LEAGUE_IDS.includes(m.league.id));

  const enriched = filtered.map(m => ({
    ...m,
    leagueMeta: LEAGUES[m.league.id] || { country: m.league.country, name: m.league.name, division: 0, gender: 'M' },
  }));

  // Update Sanity cache
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
  if (!current.includes(fixtureId)) {
    current.push(fixtureId);
  }
  await saveToSanity('appConfig', 'hiddenMatches', {
    fixtureIds: current,
    updatedAt: new Date().toISOString(),
  });
  return current;
}

export async function unhideMatch(fixtureId) {
  const current = await getHiddenMatches();
  const updated = current.filter(id => id !== fixtureId);
  await saveToSanity('appConfig', 'hiddenMatches', {
    fixtureIds: updated,
    updatedAt: new Date().toISOString(),
  });
  return updated;
}
