import { getFromSanity, saveToSanity } from '../../../lib/sanity';
import { getAvailableApiKey, getQuota } from '../../../lib/football-api';

export const dynamic = 'force-dynamic';

const API_HOST = 'v3.football.api-sports.io';

async function trackKeyCall(keyIndex) {
  const date = new Date().toISOString().split('T')[0];
  const docId = `apiQuota-${date}-key${keyIndex + 1}`;
  const doc = await getFromSanity('appConfig', docId);
  const used = (doc?.used || 0) + 1;
  await saveToSanity('appConfig', docId, { date, used, updatedAt: new Date().toISOString() });
  return used;
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

    // Dynamic refresh interval based on remaining quota
    const minInterval = quota.remaining > 100 ? 45_000 : quota.remaining > 40 ? 90_000 : 180_000;

    // Get available key for rotation
    const keyInfo = await getAvailableApiKey();

    if (keyInfo && cacheAge > minInterval && quota.remaining > 0) {
      try {
        const res = await fetch(`https://${API_HOST}/fixtures?date=${date}`, {
          headers: { 'x-apisports-key': keyInfo.key },
          cache: 'no-store',
        });

        if (!res.ok) throw new Error(`API-Football error: ${res.status}`);
        const data = await res.json();
        const allFixtures = data.response || [];
        await trackKeyCall(keyInfo.index);

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
      } catch (e) {
        console.error('API-Football live refresh error:', e.message);
      }
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
