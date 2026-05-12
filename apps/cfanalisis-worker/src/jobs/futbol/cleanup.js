// @ts-nocheck
/**
 * Job: futbol-cleanup
 * Port of /api/cron/cleanup. Deletes old rows from Supabase. Redis keys
 * expire via TTL.
 *
 * Payload: { purge?: boolean }
 */
import { supabaseAdmin } from '../../../../../lib/supabase.js';

function cutoffDateStr(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

export async function runCleanup(payload = {}) {
  const isPurge = payload.purge === true;
  const retentionDays = isPurge ? 3 : 7;
  const cutoffDate = cutoffDateStr(retentionDays);

  console.log(`[job:futbol-cleanup] ${isPurge ? 'PURGE' : 'routine'} cutoff=${cutoffDate}`);
  const results = {};

  const { error: e1, count: c1 } = await supabaseAdmin
    .from('match_analysis')
    .delete()
    .lt('date', cutoffDate)
    .select('*', { count: 'exact', head: true });
  results.match_analysis = c1 || 0;
  if (e1) console.error('[cleanup] match_analysis:', e1.message);

  const { error: e2, count: c2 } = await supabaseAdmin
    .from('fixtures_cache')
    .delete()
    .lt('date', cutoffDate)
    .select('*', { count: 'exact', head: true });
  results.fixtures_cache = c2 || 0;
  if (e2) console.error('[cleanup] fixtures_cache:', e2.message);

  const { error: e3, count: c3 } = await supabaseAdmin
    .from('match_schedule')
    .delete()
    .lt('date', cutoffDate)
    .select('*', { count: 'exact', head: true });
  results.match_schedule = c3 || 0;
  if (e3) console.error('[cleanup] match_schedule:', e3.message);

  const { error: e4, count: c4 } = await supabaseAdmin
    .from('app_config')
    .delete()
    .lt('key', `dailyBatch-${cutoffDate}`)
    .like('key', 'dailyBatch-%')
    .select('*', { count: 'exact', head: true });
  results.app_config = c4 || 0;
  if (e4) console.error('[cleanup] app_config:', e4.message);

  const total = Object.values(results).reduce((a, b) => a + b, 0);
  return { ok: true, retentionDays, cutoffDate, deleted: results, total };
}
