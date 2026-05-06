/**
 * GET /api/baseball/fixtures?date=YYYY-MM-DD
 * Returns all baseball fixtures for the date with their analyses (if available).
 */
import { getBaseballFixturesByDate } from '../../../../lib/api-baseball';
import { supabaseAdmin } from '../../../../lib/supabase';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date') || new Date().toISOString().split('T')[0];

    // Auth (optional — anon can see fixtures, but hidden/favorites need user)
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();

    const [fixturesRes, analysesRes, resultsRes, hiddenRes, favoritesRes] = await Promise.all([
      getBaseballFixturesByDate(date),
      supabaseAdmin
        .from('baseball_match_analysis')
        .select('fixture_id, probabilities, combinada, data_quality, best_odds')
        .eq('date', date),
      supabaseAdmin
        .from('baseball_match_results')
        .select('fixture_id, status, inning, inning_half, home_score, away_score, home_hits, away_hits, home_errors, away_errors')
        .eq('date', date),
      user
        ? supabaseAdmin.from('baseball_user_hidden').select('fixture_id').eq('user_id', user.id).eq('date', date)
        : Promise.resolve({ data: [] }),
      user
        ? supabaseAdmin.from('baseball_user_favorites').select('fixture_id').eq('user_id', user.id)
        : Promise.resolve({ data: [] }),
    ]);

    const analysisMap = new Map((analysesRes.data || []).map(a => [a.fixture_id, a]));
    const resultsMap = new Map((resultsRes.data || []).map(r => [r.fixture_id, r]));
    const hiddenSet = new Set((hiddenRes.data || []).map(h => h.fixture_id));
    const favoritesSet = new Set((favoritesRes.data || []).map(f => f.fixture_id));

    const enriched = (fixturesRes.fixtures || []).map(f => ({
      ...f,
      analysis: analysisMap.get(f.id) || null,
      liveResult: resultsMap.get(f.id) || null,
      isAnalyzed: analysisMap.has(f.id),
      isHidden: hiddenSet.has(f.id),
      isFavorite: favoritesSet.has(f.id),
    }));

    return Response.json({
      success: true,
      date,
      fixtures: enriched,
      fromCache: fixturesRes.fromCache,
      source: fixturesRes.source,
    });
  } catch (e) {
    console.error('[api/baseball/fixtures]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
