import { analyzeMatch, getQuota } from '../../../lib/api-football';
import { cacheAnalysis } from '../../../lib/sanity-cache';
import { createSupabaseServerClient } from '../../../lib/supabase-auth';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id || null;

    const { fixtures, date: clientDate } = await request.json();

    if (!fixtures || !Array.isArray(fixtures) || fixtures.length === 0) {
      return Response.json({ error: 'fixtures array required' }, { status: 400 });
    }

    const date = clientDate || new Date().toISOString().split('T')[0];
    const toAnalyze = fixtures.slice(0, 5);
    let totalApiCalls = 0;

    const analyses = await Promise.all(
      toAnalyze.map(async (fixture) => {
        try {
          const result = await analyzeMatch(fixture, { date });
          totalApiCalls += result.apiCalls || 0;
          // Cache analysis to Redis + Supabase
          await cacheAnalysis(fixture.fixture.id, { ...result, date }).catch(() => {});
          return { fixtureId: fixture.fixture.id, success: true, ...result };
        } catch (e) {
          return { fixtureId: fixture.fixture.id, success: false, error: e.message };
        }
      })
    );

    const quota = await getQuota();
    return Response.json({ analyses, totalApiCalls, quota });
  } catch (error) {
    console.error('[analisis]', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
