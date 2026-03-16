import { getFixtures, getQuota, getCachedStandingsPositions } from '../../../lib/api-football';
import { getAnalyzedMatchesFull } from '../../../lib/sanity-cache';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../lib/auth';
import { queryFromSanity } from '../../../lib/sanity';

export const dynamic = 'force-dynamic';

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

    // Get user-specific data
    let hidden = [];
    let analyzed = [];
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;

    if (userId) {
      const [hiddenDoc, analyzedDoc] = await Promise.all([
        queryFromSanity(
          `*[_type == "cfaUserData" && userId == $userId && dataType == "hidden"][0]`,
          { userId }
        ),
        queryFromSanity(
          `*[_type == "cfaUserData" && userId == $userId && dataType == "analyzed" && date == $date][0]`,
          { userId, date }
        ),
      ]);
      hidden = hiddenDoc?.fixtureIds || [];
      analyzed = analyzedDoc?.fixtureIds || [];
    }

    const quota = await getQuota();

    // Get analyzed match data (odds + full data) in single parallel batch
    const { analyzedOdds, analyzedData } = analyzed.length > 0
      ? await getAnalyzedMatchesFull(analyzed)
      : { analyzedOdds: {}, analyzedData: {} };

    // Get cached standings positions
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
