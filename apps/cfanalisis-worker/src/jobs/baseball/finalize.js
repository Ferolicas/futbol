// @ts-nocheck
/**
 * Job: baseball-finalize
 * Port of /api/cron/baseball/finalize. Fills actual_* columns of
 * baseball_match_predictions from baseball_match_results (no API calls).
 *
 * Payload: {}
 */
import { supabaseAdmin } from '../../shared.js';

const FINISHED = new Set(['FT', 'AOT', 'POST', 'CANC', 'INTR']);

function sumF5(innings) {
  if (!innings) return null;
  if (Array.isArray(innings)) {
    return innings.slice(0, 5).reduce((s, i) => s + (Number(i.score) || 0), 0);
  }
  if (typeof innings === 'object') {
    let total = 0;
    for (let i = 1; i <= 5; i++) {
      const v = innings[i] ?? innings[String(i)];
      if (v != null) total += Number(v) || 0;
    }
    return total;
  }
  return null;
}

export async function runBaseballFinalize(_payload = {}) {
  const since = new Date();
  since.setDate(since.getDate() - 3);
  const sinceStr = since.toISOString().split('T')[0];

  const { data: predictions, error } = await supabaseAdmin
    .from('baseball_match_predictions')
    .select('fixture_id, date')
    .gte('date', sinceStr)
    .is('finalized_at', null);

  if (error) throw error;
  if (!predictions || predictions.length === 0) {
    return { ok: true, finalized: 0, message: 'no pending predictions' };
  }

  const ids = predictions.map(p => p.fixture_id);
  const { data: results } = await supabaseAdmin
    .from('baseball_match_results')
    .select('*')
    .in('fixture_id', ids);

  const resultsMap = new Map((results || []).map(r => [r.fixture_id, r]));

  let finalized = 0, skipped = 0;
  for (const pred of predictions) {
    const r = resultsMap.get(pred.fixture_id);
    if (!r || !FINISHED.has(r.status)) {
      skipped++;
      continue;
    }
    const homeScore = r.home_score;
    const awayScore = r.away_score;
    if (homeScore == null || awayScore == null) {
      skipped++;
      continue;
    }

    const f5Home = sumF5(r.innings?.home || r.innings);
    const f5Away = sumF5(r.innings?.away || r.innings);
    const f5Total = f5Home != null && f5Away != null ? f5Home + f5Away : null;

    await supabaseAdmin.from('baseball_match_predictions').update({
      actual_home_score: homeScore,
      actual_away_score: awayScore,
      actual_total_runs: homeScore + awayScore,
      actual_run_diff: homeScore - awayScore,
      actual_result: homeScore > awayScore ? 'H' : 'A',
      actual_f5_home_score: f5Home,
      actual_f5_away_score: f5Away,
      actual_f5_total: f5Total,
      actual_btts: homeScore > 0 && awayScore > 0,
      actual_status: r.status,
      finalized_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('fixture_id', pred.fixture_id);

    finalized++;
  }

  return { ok: true, examined: predictions.length, finalized, skipped };
}
