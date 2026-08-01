/** Análisis MLB on-demand con motor empírico y cuotas API-Baseball. */
import { analyzeSportGame, MULTISPORT_CACHE_VERSION } from '../../../../lib/multisport-analysis';
import { getSportGamesByDate } from '../../../../lib/multisport-providers';
import { getApiSportsQuota } from '../../../../lib/api-sports-multisport';
import { isIsoDate } from '../../../../lib/multisport-config';
import { supabaseAdmin } from '../../../../lib/supabase';
import { getCurrentUser } from '../../../../lib/auth-pg';
import { userHasActivePlan } from '../../../../lib/require-active-plan';
import { jsonError } from '../../../../lib/api-error';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function shiftDate(date, amount) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
export async function POST(request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!(await userHasActivePlan(user))) return Response.json({ error: 'Subscription required' }, { status: 403 });
    const body = await request.json();
    const requested = [...new Set((body.fixtures || [])
      .map((fixture) => String(fixture.id || ''))
      .filter((fixtureId) => /^\d+$/.test(fixtureId)))].slice(0, 50);
    if (!requested.length) return Response.json({ error: 'No fixtures' }, { status: 400 });
    const date = body.date || new Date().toISOString().slice(0, 10);
    if (!isIsoDate(date)) return Response.json({ error: 'Invalid date' }, { status: 400 });
    const wanted = new Set(requested);
    const games = [];
    for (const candidateDate of [date, shiftDate(date, -1), shiftDate(date, 1)]) {
      const fetched = await getSportGamesByDate('baseball', candidateDate).catch(() => []);
      for (const game of fetched) if (wanted.has(String(game.id)) && !games.some((item) => item.id === game.id)) games.push(game);
      if (games.length === wanted.size) break;
    }
    const analyses = [];
    for (const fixtureId of requested) {
      try {
        const { data: existing } = await supabaseAdmin.from('baseball_match_analysis')
          .select('probabilities,combinada,cache_version').eq('fixture_id', Number(fixtureId)).maybeSingle();
        if (!body.force && Number(existing?.cache_version || 0) >= MULTISPORT_CACHE_VERSION) {
          analyses.push({ fixtureId: Number(fixtureId), success: true, cached: true, probabilities: existing.probabilities, combinada: existing.combinada });
          continue;
        }
        const game = games.find((item) => String(item.id) === fixtureId);
        if (!game) throw new Error('Partido no encontrado en MLB Stats (ventana ±1 día)');
        const result = await analyzeSportGame('baseball', game, { oddsTtl: 6 * 3600 });
        analyses.push({ fixtureId: Number(fixtureId), success: true, probabilities: result.probabilities, combinada: result.combinada });
      } catch (error) {
        analyses.push({ fixtureId: Number(fixtureId), success: false, error: error.message });
      }
    }
    const analyzedCount = analyses.filter((item) => item.success).length;
    const failedCount = analyses.length - analyzedCount;
    const quota = await getApiSportsQuota('baseball').catch(() => null);
    return Response.json({
      success: analyzedCount > 0, analyses, analyzedCount, failedCount, quota,
      ...(analyzedCount ? {} : { error: analyses[0]?.error || 'No se analizó ningún partido' }),
    });
  } catch (error) {
    console.error('[api/baseball/analisis]', error.message);
    return jsonError(error);
  }
}
