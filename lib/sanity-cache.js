import { getFromSanity, saveToSanity, queryFromSanity } from './sanity';

const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

function isStale(fetchedAt) {
  if (!fetchedAt) return true;
  return Date.now() - new Date(fetchedAt).getTime() > CACHE_TTL;
}

// ===================== FIXTURES CACHE =====================

export async function getCachedFixtures(date) {
  const doc = await getFromSanity('footballFixturesCache', date);
  if (!doc || !doc.fixtures) return null;
  if (isStale(doc.fetchedAt)) return null;
  return doc.fixtures;
}

export async function cacheFixtures(date, fixtures) {
  return saveToSanity('footballFixturesCache', date, {
    date,
    fixtures,
    fetchedAt: new Date().toISOString(),
  });
}

// ===================== MATCH ANALYSIS CACHE =====================

export async function getCachedAnalysis(fixtureId) {
  const doc = await getFromSanity('footballMatchAnalysis', String(fixtureId));
  if (!doc) return null;
  const today = new Date().toISOString().split('T')[0];
  if (doc.date !== today) return null;
  // Reject cached analysis if last 5 matches are empty — means API data wasn't fetched properly
  const hasLastFiveData = (doc.homeLastFive && doc.homeLastFive.length > 0) ||
                          (doc.awayLastFive && doc.awayLastFive.length > 0);
  if (!hasLastFiveData) return null;
  // Reject if analysis is from an older code version (missing XI, corners, etc.)
  if (!doc._cacheVersion || doc._cacheVersion < 3) return null;
  return doc;
}

export async function cacheAnalysis(fixtureId, data) {
  return saveToSanity('footballMatchAnalysis', String(fixtureId), {
    fixtureId: Number(fixtureId),
    ...data,
    _cacheVersion: 3,
    fetchedAt: new Date().toISOString(),
  });
}

// ===================== GENERIC ENDPOINT CACHE =====================

export async function getCachedEndpoint(cacheKey) {
  const doc = await getFromSanity('apiCache', cacheKey);
  if (!doc) return null;
  if (isStale(doc.fetchedAt)) return null;
  return doc.data;
}

export async function cacheEndpoint(cacheKey, data) {
  return saveToSanity('apiCache', cacheKey, {
    data,
    fetchedAt: new Date().toISOString(),
  });
}

// ===================== API CALL COUNTER =====================

export async function getApiCallCount() {
  const today = new Date().toISOString().split('T')[0];
  const doc = await getFromSanity('appConfig', `apiCalls-${today}`);
  return doc?.count || 0;
}

export async function incrementApiCallCount() {
  const today = new Date().toISOString().split('T')[0];
  const docId = `apiCalls-${today}`;
  const doc = await getFromSanity('appConfig', docId);
  const count = (doc?.count || 0) + 1;
  await saveToSanity('appConfig', docId, { date: today, count });
  return count;
}

// ===================== ANALYZED MATCHES LIST =====================

export async function getAnalyzedFixtureIds(date) {
  const doc = await getFromSanity('appConfig', `analyzed-${date}`);
  return doc?.fixtureIds || [];
}

export async function getAnalyzedOdds(fixtureIds) {
  const docs = await Promise.all(
    fixtureIds.map(id => getFromSanity('footballMatchAnalysis', String(id)))
  );
  const results = {};
  fixtureIds.forEach((id, i) => {
    if (docs[i]?.odds?.matchWinner) results[id] = docs[i].odds.matchWinner;
  });
  return results;
}

// Combined fetch — reads each doc once (parallel) and returns both odds + data
export async function getAnalyzedMatchesFull(fixtureIds) {
  if (!fixtureIds || fixtureIds.length === 0) return { analyzedOdds: {}, analyzedData: {} };
  const docs = await Promise.all(
    fixtureIds.map(id => getFromSanity('footballMatchAnalysis', String(id)))
  );
  const analyzedOdds = {};
  const analyzedData = {};
  fixtureIds.forEach((id, i) => {
    const doc = docs[i];
    if (!doc) return;
    if (doc.odds?.matchWinner) analyzedOdds[id] = doc.odds.matchWinner;
    analyzedData[id] = {
      fixtureId: doc.fixtureId, homeTeam: doc.homeTeam, awayTeam: doc.awayTeam,
      homeLogo: doc.homeLogo, awayLogo: doc.awayLogo, homeId: doc.homeId, awayId: doc.awayId,
      league: doc.league, leagueId: doc.leagueId, leagueLogo: doc.leagueLogo,
      kickoff: doc.kickoff, status: doc.status, goals: doc.goals, odds: doc.odds,
      combinada: doc.combinada, calculatedProbabilities: doc.calculatedProbabilities,
      homePosition: doc.homePosition, awayPosition: doc.awayPosition,
    };
  });
  return { analyzedOdds, analyzedData };
}

export async function markAsAnalyzed(date, fixtureId) {
  const docId = `analyzed-${date}`;
  const doc = await getFromSanity('appConfig', docId);
  const ids = doc?.fixtureIds || [];
  if (!ids.includes(fixtureId)) ids.push(fixtureId);
  await saveToSanity('appConfig', docId, { date, fixtureIds: ids });
}

// ===================== ANALYZED MATCHES DATA =====================

export async function getAnalyzedMatchesData(fixtureIds) {
  const docs = await Promise.all(
    fixtureIds.map(id => getFromSanity('footballMatchAnalysis', String(id)))
  );
  const results = {};
  fixtureIds.forEach((id, i) => {
    const doc = docs[i];
    if (!doc) return;
    results[id] = {
      fixtureId: doc.fixtureId, homeTeam: doc.homeTeam, awayTeam: doc.awayTeam,
      homeLogo: doc.homeLogo, awayLogo: doc.awayLogo, homeId: doc.homeId, awayId: doc.awayId,
      league: doc.league, leagueId: doc.leagueId, leagueLogo: doc.leagueLogo,
      kickoff: doc.kickoff, status: doc.status, goals: doc.goals, odds: doc.odds,
      combinada: doc.combinada, calculatedProbabilities: doc.calculatedProbabilities,
      homePosition: doc.homePosition, awayPosition: doc.awayPosition,
    };
  });
  return results;
}

export async function getAllStandingsFromCache(leagueIds) {
  const season = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  const results = await Promise.all(
    leagueIds.map(lid => getCachedEndpoint(`standings-${lid}-${season}`).catch(() => null))
  );
  const positions = {};
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
