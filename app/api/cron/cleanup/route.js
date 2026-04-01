/**
 * GET /api/cron/cleanup
 * Daily cleanup: remove old data from Supabase (match_analysis, fixtures_cache older than N days).
 * Redis keys expire automatically via TTL — no manual cleanup needed there.
 */
import { supabaseAdmin } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function cutoffDateStr(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret')
    || request.headers.get('authorization')?.replace('Bearer ', '');

  if (secret !== process.env.CRON_SECRET && process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const isPurge = searchParams.get('purge') === 'true';
  const retentionDays = isPurge ? 3 : 7;
  const cutoffDate = cutoffDateStr(retentionDays);

  console.log(`[CLEANUP] Starting ${isPurge ? 'PURGE' : 'routine'} cleanup — cutoff: ${cutoffDate}`);

  const results = {};

  // 1. match_analysis
  const { error: e1, count: c1 } = await supabaseAdmin
    .from('match_analysis')
    .delete()
    .lt('date', cutoffDate)
    .select('*', { count: 'exact', head: true });
  results.match_analysis = c1 || 0;
  if (e1) console.error('[CLEANUP] match_analysis:', e1.message);
  console.log(`[CLEANUP] match_analysis: ${results.match_analysis} deleted`);

  // 2. fixtures_cache
  const { error: e2, count: c2 } = await supabaseAdmin
    .from('fixtures_cache')
    .delete()
    .lt('date', cutoffDate)
    .select('*', { count: 'exact', head: true });
  results.fixtures_cache = c2 || 0;
  if (e2) console.error('[CLEANUP] fixtures_cache:', e2.message);
  console.log(`[CLEANUP] fixtures_cache: ${results.fixtures_cache} deleted`);

  // 3. match_schedule
  const { error: e3, count: c3 } = await supabaseAdmin
    .from('match_schedule')
    .delete()
    .lt('date', cutoffDate)
    .select('*', { count: 'exact', head: true });
  results.match_schedule = c3 || 0;
  if (e3) console.error('[CLEANUP] match_schedule:', e3.message);
  console.log(`[CLEANUP] match_schedule: ${results.match_schedule} deleted`);

  // 4. app_config (dated entries like dailyBatch-YYYY-MM-DD)
  const { error: e4, count: c4 } = await supabaseAdmin
    .from('app_config')
    .delete()
    .lt('key', `dailyBatch-${cutoffDate}`)
    .like('key', 'dailyBatch-%')
    .select('*', { count: 'exact', head: true });
  results.app_config = c4 || 0;
  if (e4) console.error('[CLEANUP] app_config:', e4.message);
  console.log(`[CLEANUP] app_config: ${results.app_config} deleted`);

  // 5. user_hidden (entries older than 60 days — safety cleanup)
  // Only clear if table has a date column for pruning

  const total = Object.values(results).reduce((a, b) => a + b, 0);
  console.log(`[CLEANUP] Done — ${total} rows deleted total`);

  return Response.json({
    success: true,
    retentionDays,
    cutoffDate,
    deleted: results,
    total,
    timestamp: new Date().toISOString(),
  });
}
