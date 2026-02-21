import { getBzzoiroLive, matchBzzoiroToFixtures, applyLiveUpdates } from '../../../lib/bzzoiro-api';
import { getFromSanity, saveToSanity } from '../../../lib/sanity';

export const dynamic = 'force-dynamic';

const API_HOST = 'v3.football.api-sports.io';

// Direct API-Football call for live fixtures refresh (1 API call)
async function refreshFromApiFootball(date, apiKey) {
  const res = await fetch(`https://${API_HOST}/fixtures?date=${date}`, {
    headers: { 'x-apisports-key': apiKey },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`API-Football error: ${res.status}`);
  const data = await res.json();
  return data.response || [];
}

// Track API call usage
async function trackCall() {
  const key = new Date().toISOString().split('T')[0];
  const doc = await getFromSanity('appConfig', `apiQuota-${key}`);
  const used = (doc?.used || 0) + 1;
  await saveToSanity('appConfig', `apiQuota-${key}`, { date: key, used, updatedAt: new Date().toISOString() });
  return used;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date');
  const bzzoiroKey = process.env.BZZOIRO_API_KEY;
  const footballKey = process.env.FOOTBALL_API_KEY;

  if (!date) {
    return Response.json({ error: 'date parameter required' }, { status: 400 });
  }

  try {
    // Get current cached matches from Sanity
    const cached = await getFromSanity('matchDay', date);
    const fixtures = cached?.matches || [];
    const cacheAge = cached?.fetchedAt ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;

    if (fixtures.length === 0) {
      return Response.json({ matches: [], source: 'empty', updatedAt: null });
    }

    // === STRATEGY 1: Bzzoiro (free, unlimited) ===
    if (bzzoiroKey) {
      try {
        const liveData = await getBzzoiroLive(bzzoiroKey);
        const updates = matchBzzoiroToFixtures(liveData, fixtures);
        const updatedMatches = applyLiveUpdates(fixtures, updates);
        const now = new Date().toISOString();

        await saveToSanity('matchDay', date, {
          date,
          matches: updatedMatches,
          fetchedAt: now,
          matchCount: updatedMatches.length,
        });

        return Response.json({
          matches: updatedMatches,
          source: 'bzzoiro',
          liveUpdated: Object.keys(updates).length,
          updatedAt: now,
        });
      } catch (e) {
        console.error('Bzzoiro live error:', e.message);
        // Fall through to API-Football
      }
    }

    // === STRATEGY 2: API-Football (costs 1 call, throttled to max 1/min) ===
    if (footballKey && cacheAge > 60_000) {
      try {
        const { ALL_LEAGUE_IDS, LEAGUES } = await import('../../../lib/leagues');

        const allFixtures = await refreshFromApiFootball(date, footballKey);
        await trackCall();

        const filtered = allFixtures
          .filter(m => ALL_LEAGUE_IDS.includes(m.league.id))
          .map(m => ({
            ...m,
            leagueMeta: LEAGUES[m.league.id] || { country: m.league.country, name: m.league.name, division: 0, gender: 'M' },
            _liveSource: 'api-football',
          }));

        const now = new Date().toISOString();

        await saveToSanity('matchDay', date, {
          date,
          matches: filtered,
          fetchedAt: now,
          matchCount: filtered.length,
        });

        return Response.json({
          matches: filtered,
          source: 'api-football',
          liveUpdated: filtered.filter(m =>
            ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'].includes(m.fixture?.status?.short)
          ).length,
          updatedAt: now,
          apiCallUsed: true,
        });
      } catch (e) {
        console.error('API-Football live refresh error:', e.message);
      }
    }

    // === FALLBACK: Return cached data with age info ===
    return Response.json({
      matches: fixtures,
      source: 'cache',
      updatedAt: cached?.fetchedAt || null,
      cacheAgeSec: Math.round(cacheAge / 1000),
      nextRefreshIn: Math.max(0, Math.round((60_000 - cacheAge) / 1000)),
    });
  } catch (error) {
    console.error('Live scores error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
