import { getFromSanity, saveToSanity } from '../../../lib/sanity';

export const dynamic = 'force-dynamic';

const API_HOST = 'v3.football.api-sports.io';

async function trackCall() {
  const key = new Date().toISOString().split('T')[0];
  const doc = await getFromSanity('appConfig', `apiQuota-${key}`);
  const used = (doc?.used || 0) + 1;
  await saveToSanity('appConfig', `apiQuota-${key}`, { date: key, used, updatedAt: new Date().toISOString() });
  return used;
}

async function getQuota() {
  const key = new Date().toISOString().split('T')[0];
  const doc = await getFromSanity('appConfig', `apiQuota-${key}`);
  const used = doc?.used || 0;
  return { used, remaining: 100 - used, limit: 100 };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date');
  const idsParam = searchParams.get('ids'); // comma-separated fixture IDs being tracked
  const footballKey = process.env.FOOTBALL_API_KEY;

  if (!date) {
    return Response.json({ error: 'date parameter required' }, { status: 400 });
  }

  try {
    const { ALL_LEAGUE_IDS, LEAGUES } = await import('../../../lib/leagues');

    // Get cached data and check age
    const cached = await getFromSanity('matchDay', date);
    const fixtures = cached?.matches || [];
    const cacheAge = cached?.fetchedAt ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;
    const quota = await getQuota();

    // Determine refresh interval based on remaining quota
    // >50 calls: 45s, >20 calls: 90s, else: 180s
    const minInterval = quota.remaining > 50 ? 45_000 : quota.remaining > 20 ? 90_000 : 180_000;

    // Only call API-Football if cache is stale enough and we have quota
    if (footballKey && cacheAge > minInterval && quota.remaining > 0) {
      try {
        const res = await fetch(`https://${API_HOST}/fixtures?date=${date}`, {
          headers: { 'x-apisports-key': footballKey },
          cache: 'no-store',
        });

        if (!res.ok) throw new Error(`API-Football error: ${res.status}`);
        const data = await res.json();
        const allFixtures = data.response || [];
        await trackCall();

        const filtered = allFixtures
          .filter(m => ALL_LEAGUE_IDS.includes(m.league.id))
          .map(m => ({
            ...m,
            leagueMeta: LEAGUES[m.league.id] || { country: m.league.country, name: m.league.name, division: 0, gender: 'M' },
          }));

        const now = new Date().toISOString();

        await saveToSanity('matchDay', date, {
          date,
          matches: filtered,
          fetchedAt: now,
          matchCount: filtered.length,
        });

        // If specific IDs requested, filter to those
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
          refreshInterval: updatedQuota.remaining > 50 ? 45 : updatedQuota.remaining > 20 ? 90 : 180,
          quota: updatedQuota,
        });
      } catch (e) {
        console.error('API-Football live refresh error:', e.message);
      }
    }

    // Return cached data (no API call)
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
      refreshInterval: quota.remaining > 50 ? 45 : quota.remaining > 20 ? 90 : 180,
      quota,
    });
  } catch (error) {
    console.error('Live scores error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
