/**
 * GET /api/cron/baseball/cleanup
 * Deletes baseball cache rows older than retention windows.
 * Schedule: "0 3 * * *"  (UTC 03:00 = Spain 05:00, daily)
 */
import { supabaseAdmin } from '../../../../../lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function verifyAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret') || request.headers.get('authorization')?.replace('Bearer ', '');
  return secret === process.env.CRON_SECRET || process.env.NODE_ENV !== 'production';
}

const cutoff = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
};

export async function GET(request) {
  if (!verifyAuth(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const fixturesCutoff = cutoff(7);
    const analysisCutoff = cutoff(30);
    const resultsCutoff = cutoff(60);

    const [a, b, c] = await Promise.all([
      supabaseAdmin.from('baseball_fixtures_cache').delete().lt('date', fixturesCutoff),
      supabaseAdmin.from('baseball_match_analysis').delete().lt('date', analysisCutoff),
      supabaseAdmin.from('baseball_match_results').delete().lt('date', resultsCutoff),
    ]);

    return Response.json({ success: true, deleted: { fixtures: a.count, analysis: b.count, results: c.count } });
  } catch (e) {
    console.error('[CRON:baseball/cleanup]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
