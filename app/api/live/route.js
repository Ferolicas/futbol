import { getFromSanity, saveToSanity } from '../../../lib/sanity';
import { getQuota } from '../../../lib/football-api';

export const dynamic = 'force-dynamic';

const API_HOST = 'v3.football.api-sports.io';
const DAILY_LIMIT = 100;

function getApiKeys() {
  const keys = [];
  if (process.env.FOOTBALL_API_KEY) keys.push(process.env.FOOTBALL_API_KEY);
  if (process.env.FOOTBALL_API_KEY_2) keys.push(process.env.FOOTBALL_API_KEY_2);
  return keys;
}

async function trackKeyCall(keyIndex) {
  const date = new Date().toISOString().split('T')[0];
  const docId = `apiQuota-${date}-key${keyIndex + 1}`;
  const doc = await getFromSanity('appConfig', docId);
  const used = (doc?.used || 0) + 1;
  await saveToSanity('appConfig', docId, { date, used, updatedAt: new Date().toISOString() });
  return used;
}

// Try API call with key rotation
async function tryApiCall(endpoint) {
  const keys = getApiKeys();
  for (let i = 0; i < keys.length; i++) {
    try {
      const res = await fetch(`https://${API_HOST}${endpoint}`, {
        headers: { 'x-apisports-key': keys[i] },
        cache: 'no-store',
      });
      if (!res.ok) continue;
      const data = await res.json();

      // Detect API errors (rate limit, suspended, etc.)
      if (data.errors && Object.keys(data.errors).length > 0) {
        console.error(`Live key${i + 1} error:`, data.errors);
        // Mark key as exhausted
        const date = new Date().toISOString().split('T')[0];
        const docId = `apiQuota-${date}-key${i + 1}`;
        await saveToSanity('appConfig', docId, { date, used: DAILY_LIMIT, updatedAt: new Date().toISOString() });
        continue;
      }

      await trackKeyCall(i);
      return data.response || [];
    } catch (e) {
      console.error(`Live key${i + 1} fetch error:`, e.message);
      continue;
    }
  }
  return null; // All keys failed
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date');
  const idsParam = searchParams.get('ids');

  if (!date) {
    return Response.json({ error: 'date parameter required' }, { status: 400 });
  }

  try {
    const { ALL_LEAGUE_IDS, LEAGUES } = await import('../../../lib/leagues');

    const cached = await getFromSanity('matchDay', date);
    const fixtures = cached?.matches || [];
    const cacheAge = cached?.fetchedAt ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;
    const quota = await getQuota();

    // Dynamic refresh interval
    const minInterval = quota.remaining > 100 ? 45_000 : quota.remaining > 40 ? 90_000 : 180_000;

    if (cacheAge > minInterval && quota.remaining > 0) {
      const allFixtures = await tryApiCall(`/fixtures?date=${date}`);

      if (allFixtures && allFixtures.length > 0) {
        const filtered = allFixtures
          .filter(m => ALL_LEAGUE_IDS.includes(m.league.id))
          .map(m => ({
            ...m,
            leagueMeta: LEAGUES[m.league.id] || { country: m.league.country, name: m.league.name, division: 0, gender: 'M' },
          }));

        const now = new Date().toISOString();

        // Only save if we got real data
        if (filtered.length > 0) {
          await saveToSanity('matchDay', date, {
            date,
            matches: filtered,
            fetchedAt: now,
            matchCount: filtered.length,
          });
        }

        const trackedIds = idsParam ? new Set(idsParam.split(',').map(Number)) : null;
        const responseMatches = trackedIds
          ? filtered.filter(m => trackedIds.has(m.fixture.id))
          : filtered;

        const updatedQuota = await getQuota();

        return Response.json({
          matches: responseMatches,
          allCount: filtered.length,
          source: 'api-football',
          updatedAt: now,
          apiCallUsed: true,
          refreshInterval: updatedQuota.remaining > 100 ? 45 : updatedQuota.remaining > 40 ? 90 : 180,
          quota: updatedQuota,
        });
      }
      // API failed - fall through to cache
    }

    // Return cached data
    const trackedIds = idsParam ? new Set(idsParam.split(',').map(Number)) : null;
    const responseMatches = trackedIds
      ? fixtures.filter(m => trackedIds.has(m.fixture.id))
      : fixtures;

    return Response.json({
      matches: responseMatches,
      allCount: fixtures.length,
      source: 'cache',
      updatedAt: cached?.fetchedAt || null,
      cacheAgeSec: Math.round(cacheAge / 1000),
      refreshInterval: quota.remaining > 100 ? 45 : quota.remaining > 40 ? 90 : 180,
      quota,
    });
  } catch (error) {
    console.error('Live scores error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
