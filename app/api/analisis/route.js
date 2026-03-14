import { analyzeMatch, getQuota } from '../../../lib/api-football';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const { fixtures } = await request.json();

    if (!fixtures || !Array.isArray(fixtures) || fixtures.length === 0) {
      return Response.json({ error: 'fixtures array required' }, { status: 400 });
    }

    // Limit to 5 matches per request
    const toAnalyze = fixtures.slice(0, 5);
    const results = [];
    let totalApiCalls = 0;

    // Analyze in parallel
    const analyses = await Promise.all(
      toAnalyze.map(async (fixture) => {
        try {
          const result = await analyzeMatch(fixture);
          totalApiCalls += result.apiCalls;
          return { fixtureId: fixture.fixture.id, success: true, ...result };
        } catch (e) {
          return {
            fixtureId: fixture.fixture.id,
            success: false,
            error: e.message,
          };
        }
      })
    );

    const quota = await getQuota();

    return Response.json({
      analyses,
      totalApiCalls,
      quota,
    });
  } catch (error) {
    console.error('Analysis error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
