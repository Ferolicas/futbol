import { analyzeMatch, getQuota } from '../../../lib/api-football';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../../lib/auth';
import { queryFromSanity, saveToSanity } from '../../../lib/sanity';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id || null;

    const { fixtures, date: clientDate } = await request.json();

    if (!fixtures || !Array.isArray(fixtures) || fixtures.length === 0) {
      return Response.json({ error: 'fixtures array required' }, { status: 400 });
    }

    // Use client-provided date, fallback to UTC
    const date = clientDate || new Date().toISOString().split('T')[0];

    // Limit to 5 matches per request
    const toAnalyze = fixtures.slice(0, 5);
    let totalApiCalls = 0;

    // Analyze in parallel
    const analyses = await Promise.all(
      toAnalyze.map(async (fixture) => {
        try {
          const result = await analyzeMatch(fixture, { date });
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

    // Save analyzed fixture IDs per-user
    const successfulIds = analyses.filter(a => a.success).map(a => a.fixtureId);
    if (userId && successfulIds.length > 0) {
      const docId = `analyzed-${userId.replace('cfaUser-', '')}-${date}`;
      const existing = await queryFromSanity(
        `*[_type == "cfaUserData" && userId == $userId && dataType == "analyzed" && date == $date][0]`,
        { userId, date }
      );
      const ids = existing?.fixtureIds || [];
      successfulIds.forEach(id => { if (!ids.includes(id)) ids.push(id); });

      await saveToSanity('cfaUserData', docId, {
        userId,
        dataType: 'analyzed',
        date,
        fixtureIds: ids,
        updatedAt: new Date().toISOString(),
      });
    }

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
