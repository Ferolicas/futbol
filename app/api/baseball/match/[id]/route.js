/**
 * GET /api/baseball/match/[id]
 * Returns the full analysis for a single baseball game.
 */
import { supabaseAdmin } from '../../../../../lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(_request, { params }) {
  try {
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
    return Response.json({ error: e.message }, { status: 500 });
  }
}
