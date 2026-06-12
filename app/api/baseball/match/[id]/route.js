/**
 * GET /api/baseball/match/[id]
 * Returns the full analysis for a single baseball game.
 */
import { supabaseAdmin } from '../../../../../lib/supabase';
import { getCurrentUser } from '../../../../../lib/auth-pg';
import { userHasActivePlan } from '../../../../../lib/require-active-plan';
import { jsonError } from '../../../../../lib/api-error';

export const dynamic = 'force-dynamic';

export async function GET(_request, { params }) {
  try {
    // R13 FIX: análisis premium de baseball → exigir sesión + plan activo/admin
    // (consistente con la lista /api/baseball/fixtures y con fútbol).
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!(await userHasActivePlan(user))) {
      return Response.json({ error: 'Subscription required' }, { status: 403 });
    }
    const fixtureId = Number(params.id);
    if (!fixtureId) return Response.json({ error: 'Invalid id' }, { status: 400 });

    const [analysisRes, resultRes] = await Promise.all([
      supabaseAdmin.from('baseball_match_analysis').select('*').eq('fixture_id', fixtureId).maybeSingle(),
      supabaseAdmin.from('baseball_match_results').select('*').eq('fixture_id', fixtureId).maybeSingle(),
    ]);

    if (!analysisRes.data) {
      return Response.json({ error: 'Not analyzed yet' }, { status: 404 });
    }

    return Response.json({
      success: true,
      analysis: analysisRes.data,
      result: resultRes.data || null,
    });
  } catch (e) {
    console.error('[api/baseball/match]', e.message);
    return jsonError(e);
  }
}
