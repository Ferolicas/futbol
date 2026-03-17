import { getFixtures, getQuota } from '../../../lib/api-football';
import { getAnalyzedMatchesFull } from '../../../lib/sanity-cache';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../lib/auth';
import { queryFromSanity, getFromSanity } from '../../../lib/sanity';
import { getCachedStandingsPositions } from '../../../lib/api-football';

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

    // Auto-trigger daily batch if first visit of the day (using client's date)
    if (fixtures.length > 0) {
      const batchFlag = await getFromSanity('appConfig', `dailyBatch-${date}`);
      if (!batchFlag?.started) {
        // First visit of the day — trigger full analysis batch in background
        const baseUrl = process.env.NEXTAUTH_URL || (process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : 'http://localhost:3000');

        fetch(`${baseUrl}/api/cron/daily?date=${date}`, {
          headers: { 'x-internal-trigger': 'true' },
        }).catch(() => {}); // Fire and forget
      }
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

    // Get globally analyzed matches (from daily batch)
    // Query Sanity for which of today's fixtures have analysis cached
    const fixtureIds = fixtures.map(f => f.fixture.id);
    let globallyAnalyzed = [];

    if (fixtureIds.length > 0) {
      const analyzedDocs = await queryFromSanity(
        `*[_type == "footballMatchAnalysis" && fixtureId in $ids]{ fixtureId }`,
        { ids: fixtureIds }
      );
      globallyAnalyzed = (analyzedDocs || []).map(d => d.fixtureId);
    }

    // Only fetch full data for analyzed matches
    const { analyzedOdds, analyzedData } = globallyAnalyzed.length > 0
      ? await getAnalyzedMatchesFull(globallyAnalyzed)
      : { analyzedOdds: {}, analyzedData: {} };

    const quota = await getQuota();

    // Get cached standings positions
    let standings = {};
    if (fixtures.length > 0) {
      const leagueIds = [...new Set(fixtures.map(f => f.league?.id).filter(Boolean))];
      try {
        standings = await getCachedStandingsPositions(leagueIds);
      } catch {}
    }

    // Batch status
    const batchFlag = await getFromSanity('appConfig', `dailyBatch-${date}`);

    return Response.json({
      fixtures,
      fromCache,
      stale,
      quota,
      hidden,
      analyzed: globallyAnalyzed,
      analyzedOdds,
      analyzedData,
      standings,
      batchStatus: batchFlag ? {
        started: batchFlag.started || false,
        completed: batchFlag.completed || false,
      } : null,
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
