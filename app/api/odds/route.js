/**
 * GET /api/odds
 * Returns odds from Redis cache (stored by cron/odds).
 */
import { redisGet } from '../../../lib/redis';
import { createSupabaseServerClient } from '../../../lib/supabase-auth';
import { userHasActivePlan } from '../../../lib/require-active-plan';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request) {
  // Contenido de pago: exigir sesión + plan activo o admin (igual que baseball).
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!(await userHasActivePlan(user))) {
    return Response.json({ error: 'Subscription required' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const fixtureId = searchParams.get('fixtureId');

  try {
    if (fixtureId) {
      const odds = await redisGet(`odds:fixture:${fixtureId}`);
      if (!odds) return Response.json({ odds: null, highProbBets: [] });
      return Response.json({ odds, fetchedAt: odds.fetchedAt });
    }

    // All odds for a date
    const oddsMap = await redisGet(`odds:date:${date}`);
    return Response.json({
      odds: oddsMap || {},
      count: Object.keys(oddsMap || {}).length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ odds: {}, error: error.message });
  }
}
