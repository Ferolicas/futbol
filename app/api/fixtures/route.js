import { getFixtures, getQuota, getHiddenMatches, getCachedStandingsPositions } from '../../../lib/api-football';
import { getAnalyzedFixtureIds, getAnalyzedOdds, getAnalyzedMatchesData } from '../../../lib/sanity-cache';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];

  try {
    let fixtures = [];
    let fromCache = false;
    let stale = false;
    let error = null;

    try {
      const result = await getFixtures(date);
      fixtures = result.fixtures || [];
      fromCache = result.fromCache || false;
      stale = result.stale || false;
    } catch (e) {
      error = e.message === 'RATE_LIMIT'
        ? 'Limite de llamadas alcanzado. Usando datos en cache.'
        : e.message;
    }

    const [quota, hidden, analyzed] = await Promise.all([
      getQuota(),
      getHiddenMatches(),
      getAnalyzedFixtureIds(date),
    ]);

    // Get analyzed match data (odds, combinadas, positions) in parallel
    const [analyzedOdds, analyzedData] = await Promise.all([
      analyzed.length > 0 ? getAnalyzedOdds(analyzed) : {},
      analyzed.length > 0 ? getAnalyzedMatchesData(analyzed) : {},
    ]);

    // Get cached standings positions for all leagues in today's fixtures
    let standings = {};
    if (fixtures.length > 0) {
      const leagueIds = [...new Set(fixtures.map(f => f.league?.id).filter(Boolean))];
      try {
        standings = await getCachedStandingsPositions(leagueIds);
      } catch {}
    }

    return Response.json({
      fixtures,
      fromCache,
      stale,
      quota,
      hidden,
      analyzed,
      analyzedOdds,
      analyzedData,
      standings,
      ...(error ? { error } : {}),
    });
  } catch (e) {
    const quota = await getQuota().catch(() => ({ used: 0, remaining: 100, limit: 100 }));
    return Response.json({
      error: e.message || 'Error loading fixtures',
      fixtures: [],
      quota,
      hidden: [],
      analyzed: [],
      analyzedOdds: {},
      analyzedData: {},
      standings: {},
    });
  }
}
