// @ts-nocheck
/**
 * Job: baseball-cleanup
 * Port of /api/cron/baseball/cleanup. Deletes baseball cache rows older
 * than retention windows.
 *
 * Payload: {}
 */
import { supabaseAdmin } from '../../shared.js';

const cutoff = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
};

export async function runBaseballCleanup(_payload = {}) {
  const fixturesCutoff = cutoff(7);
  const analysisCutoff = cutoff(30);
  const resultsCutoff = cutoff(60);

  const [a, b, c] = await Promise.all([
    supabaseAdmin.from('baseball_fixtures_cache').delete().lt('date', fixturesCutoff),
    supabaseAdmin.from('baseball_match_analysis').delete().lt('date', analysisCutoff),
    supabaseAdmin.from('baseball_match_results').delete().lt('date', resultsCutoff),
  ]);

  return { ok: true, deleted: { fixtures: a.count, analysis: b.count, results: c.count } };
}
