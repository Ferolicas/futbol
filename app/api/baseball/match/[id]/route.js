/**
 * GET /api/baseball/match/[id]
 * Returns the full analysis for a single baseball game.
 */
import { supabaseAdmin } from '../../../../../lib/supabase';
import { getCurrentUser } from '../../../../../lib/auth-pg';
import { freeAnalysis } from '../../../../../lib/free-access';
import { userHasActivePlan } from '../../../../../lib/require-active-plan';
import { jsonError } from '../../../../../lib/api-error';
import { MULTISPORT_CACHE_VERSION } from '../../../../../lib/multisport-analysis';

export const dynamic = 'force-dynamic';

export async function GET(_request, props) {
  const params = await props.params;
  try {
    // R13 FIX: análisis premium de baseball → exigir sesión + plan activo/admin
    // (consistente con la lista /api/baseball/fixtures y con fútbol).
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const paidAccess = await userHasActivePlan(user);

    const fixtureId = Number(params.id);
    if (!fixtureId) return Response.json({ error: 'Invalid id' }, { status: 400 });

    const [analysisRes, resultRes] = await Promise.all([
      supabaseAdmin.from('baseball_match_analysis').select('*')
        .eq('fixture_id', fixtureId)
        .gte('cache_version', MULTISPORT_CACHE_VERSION)
        .maybeSingle(),
      supabaseAdmin.from('baseball_match_results').select('*').eq('fixture_id', fixtureId).maybeSingle(),
    ]);

    if (!analysisRes.data) {
      return Response.json({ error: 'Not analyzed yet' }, { status: 404 });
    }

    const result = resultRes.data || null;
    const game = {
      ...analysisRes.data,
      id: fixtureId,
      status: result?.status || analysisRes.data.status,
      liveResult: result,
    };
    return Response.json({
      success: true,
      analysis: paidAccess ? analysisRes.data : freeAnalysis(
        analysisRes.data,
        'baseball',
        { game, liveResult: result },
      ),
      result,
    });
  } catch (e) {
    console.error('[api/baseball/match]', e.message);
    return jsonError(e);
  }
}
