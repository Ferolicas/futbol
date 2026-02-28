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
  return null;
}

export async function getQuota() {
  const keys = getApiKeys();
  let totalUsed = 0;
  const totalLimit = Math.max(keys.length, 1) * DAILY_LIMIT;

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

  // Detect API-level errors (rate limit, suspended, etc.)
  if (data.errors && Object.keys(data.errors).length > 0) {
    const errMsg = Object.values(data.errors).join('; ');
    console.error('API-Football errors:', errMsg);
    throw new Error(`API-Football: ${errMsg}`);
  }

  return data.response;
}

async function trackedApiCall(endpoint, keyInfo) {
  const result = await apiCall(endpoint, keyInfo.key);
  await trackKeyCall(keyInfo.index);
  return result;
}

// Try API call with key rotation - if one key fails, try the next
async function resilientApiCall(endpoint) {
  const keys = getApiKeys();
  for (let i = 0; i < keys.length; i++) {
    try {
      const result = await apiCall(endpoint, keys[i]);
      await trackKeyCall(i);
      return result;
    } catch (e) {
      console.error(`Key ${i + 1} failed: ${e.message}`);
      // Mark this key as exhausted in our tracker
      const date = todayKey();
      const docId = `apiQuota-${date}-key${i + 1}`;
      await saveToSanity('appConfig', docId, { date, used: DAILY_LIMIT, updatedAt: new Date().toISOString() });
      continue;
    }
  }
  return null; // All keys failed
}

// ===================== MATCHES =====================

export async function getMatches(date) {
  // Always try cache first
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

  // Cache stale or empty - try API with key rotation
  const allFixtures = await resilientApiCall(`/fixtures?date=${date}`);
  const quota = await getQuota();

  // API failed completely - return stale cache if available
  if (!allFixtures) {
    if (cached && cached.matches && cached.matches.length > 0) {
      return { matches: cached.matches, fromCache: true, apiCalls: 0, quota };
    }
    return { matches: [], fromCache: false, apiCalls: 0, quota };
  }

  const filtered = allFixtures.filter(m => ALL_LEAGUE_IDS.includes(m.league.id));

  const enriched = filtered.map(m => ({
    ...m,
    leagueMeta: LEAGUES[m.league.id] || { country: m.league.country, name: m.league.name, division: 0, gender: 'M' },
  }));

  // ONLY save to cache if we got actual matches - never overwrite good data with empty
  if (enriched.length > 0) {
    await saveToSanity('matchDay', date, {
      date,
      matches: enriched,
      fetchedAt: new Date().toISOString(),
      matchCount: enriched.length,
    });
  }

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
