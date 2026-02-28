import { ALL_LEAGUE_IDS, LEAGUES } from './leagues';
import { getFromSanity, saveToSanity } from './sanity';

const API_HOST = 'v3.football.api-sports.io';
const DAILY_LIMIT = 100; // per key

// ===================== DUAL API KEY ROTATION =====================

function getApiKeys() {
  const keys = [];
  if (process.env.FOOTBALL_API_KEY) keys.push(process.env.FOOTBALL_API_KEY);
  if (process.env.FOOTBALL_API_KEY_2) keys.push(process.env.FOOTBALL_API_KEY_2);
  return keys;
}

function todayKey() {
  return new Date().toISOString().split('T')[0];
}

async function getKeyQuota(keyIndex) {
  const date = todayKey();
  const doc = await getFromSanity('appConfig', `apiQuota-${date}-key${keyIndex + 1}`);
  const used = doc?.used || 0;
  return { used, remaining: Math.max(0, DAILY_LIMIT - used) };
}

async function trackKeyCall(keyIndex) {
  const date = todayKey();
  const docId = `apiQuota-${date}-key${keyIndex + 1}`;
  const doc = await getFromSanity('appConfig', docId);
  const used = (doc?.used || 0) + 1;
  await saveToSanity('appConfig', docId, { date, used, updatedAt: new Date().toISOString() });
  return used;
}

export async function getAvailableApiKey() {
  const keys = getApiKeys();
  if (keys.length === 0) return null;

  for (let i = 0; i < keys.length; i++) {
    const quota = await getKeyQuota(i);
    if (quota.remaining > 0) {
      return { key: keys[i], index: i };
    }
  }
  return null; // all keys exhausted
}

export async function getQuota() {
  const keys = getApiKeys();
  let totalUsed = 0;
  const totalLimit = keys.length * DAILY_LIMIT;

  for (let i = 0; i < keys.length; i++) {
    const q = await getKeyQuota(i);
    totalUsed += q.used;
  }

  return {
    used: totalUsed,
    remaining: Math.max(0, totalLimit - totalUsed),
    limit: totalLimit,
    date: todayKey(),
    keyCount: keys.length,
  };
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

// Tracked API call with key rotation
async function trackedApiCall(endpoint, keyInfo) {
  const result = await apiCall(endpoint, keyInfo.key);
  await trackKeyCall(keyInfo.index);
  return result;
}

// ===================== MATCHES =====================

export async function getMatches(date, keyInfo) {
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

  const allFixtures = await trackedApiCall(`/fixtures?date=${date}`, keyInfo);
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
