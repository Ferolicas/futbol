import { createSupabaseServerClient } from '../../../lib/supabase-auth';
import { userHasActivePlan } from '../../../lib/require-active-plan';
import { pgPool } from '../../../lib/db';
import {
  normalizeDashboardSearchQuery,
  parseDashboardSearchSports,
  searchDashboardMatches,
} from '../../../lib/dashboard-search';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!(await userHasActivePlan(user))) {
      return Response.json({ error: 'Subscription required' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const query = normalizeDashboardSearchQuery(searchParams.get('q'));
    const sportsParam = searchParams.get('sports');
    const sports = parseDashboardSearchSports(sportsParam);
    if (query.length < 2) {
      return Response.json({ success: true, query, sports, results: [], count: 0 });
    }
    if (sportsParam && sports.length === 0) {
      return Response.json({ error: 'Invalid sports filter' }, { status: 400 });
    }

    const results = await searchDashboardMatches(pgPool, {
      query,
      sports: sports.join(','),
      limit: 28,
    });
    return Response.json(
      { success: true, query, sports, results, count: results.length },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    console.error('[api/dashboard-search]', error.message);
    return Response.json({ error: 'No se pudo completar la búsqueda.' }, { status: 500 });
  }
}
