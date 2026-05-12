// @ts-nocheck
/**
 * Job: baseball-analyze
 * Port of /api/cron/baseball/analyze. Computes probs + combinada + data quality
 * for each game and persists baseball_match_analysis + baseball_match_predictions.
 *
 * Payload: { date?: string }
 */
import { getBaseballFixturesByDate, getBaseballOddsByGame, getBaseballTeamStats, getBaseballH2H, getBaseballQuota } from '../../../../../lib/api-baseball.js';
import { computeBaseballProbabilities, buildBaseballCombinada, scoreBaseballDataQuality, extractBestOdds } from '../../../../../lib/baseball-model.js';
import { calibrateBaseballProbabilities, flattenProbabilitiesForStorage } from '../../../../../lib/baseball-calibration.js';
import { supabaseAdmin } from '../../../../../lib/supabase.js';

export async function runBaseballAnalyze(payload = {}) {
  const date = payload.date || new Date().toISOString().split('T')[0];

  const { fixtures } = await getBaseballFixturesByDate(date);
  if (!fixtures || fixtures.length === 0) {
    return { ok: true, analyzed: 0, message: 'no fixtures', date };
  }

  let analyzed = 0, skipped = 0, failed = 0;
  const errors = [];

  for (const game of fixtures) {
    const fixtureId = game.id;
    try {
      const { data: existing } = await supabaseAdmin
        .from('baseball_match_analysis')
        .select('fixture_id, updated_at')
        .eq('fixture_id', fixtureId)
        .maybeSingle();
      const ageMs = existing ? (Date.now() - new Date(existing.updated_at).getTime()) : Infinity;
      if (existing && ageMs < 6 * 3600 * 1000) {
        skipped++;
        continue;
      }

      const quota = await getBaseballQuota();
      if (quota.remaining < 5) {
        console.log(`[job:baseball-analyze] quota low (${quota.remaining}), stopping`);
        break;
      }

      const homeId = game.teams?.home?.id;
      const awayId = game.teams?.away?.id;
      const leagueId = game.league?.id;

      const [oddsRes, h2hRes, homeStatsRes, awayStatsRes] = await Promise.allSettled([
        getBaseballOddsByGame(fixtureId),
        getBaseballH2H(homeId, awayId),
        getBaseballTeamStats(homeId, leagueId),
        getBaseballTeamStats(awayId, leagueId),
      ]);

      const odds = oddsRes.status === 'fulfilled' ? oddsRes.value.odds : [];
      const h2h = h2hRes.status === 'fulfilled' ? h2hRes.value.h2h : [];
      const homeStats = homeStatsRes.status === 'fulfilled' ? homeStatsRes.value.stats : null;
      const awayStats = awayStatsRes.status === 'fulfilled' ? awayStatsRes.value.stats : null;

      const rawProbs = computeBaseballProbabilities({
        homeStats, awayStats, homeId, awayId, h2h,
        marketOdds: odds,
      });
      const probs = await calibrateBaseballProbabilities(rawProbs);

      const bestOdds = extractBestOdds(odds);
      const combinada = buildBaseballCombinada(probs, bestOdds);
      const dq = scoreBaseballDataQuality({ homeStats, awayStats, h2h, odds });

      await supabaseAdmin.from('baseball_match_analysis').upsert({
        fixture_id: fixtureId,
        date,
        league_id: leagueId,
        league_name: game.league?.name,
        country: game.country?.name,
        home_team_id: homeId,
        away_team_id: awayId,
        home_team: game.teams?.home?.name,
        away_team: game.teams?.away?.name,
        status: game.status?.short || game.status?.long || 'NS',
        start_time: game.date,
        analysis: { homeStats, awayStats, h2h: h2h.slice(0, 10) },
        odds,
        best_odds: bestOdds,
        probabilities: probs,
        combinada,
        data_quality: dq,
        updated_at: new Date().toISOString(),
      });

      await supabaseAdmin.from('baseball_match_predictions').upsert({
        fixture_id: fixtureId,
        date,
        league_id: leagueId,
        home_team_id: homeId,
        away_team_id: awayId,
        ...flattenProbabilitiesForStorage(probs),
        updated_at: new Date().toISOString(),
      });

      analyzed++;
    } catch (e) {
      console.error(`[job:baseball-analyze] fixture ${fixtureId}:`, e.message);
      failed++;
      errors.push({ fixtureId, error: e.message });
      if (e.message?.startsWith('BASEBALL_QUOTA_EXHAUSTED')) break;
    }
  }

  const quota = await getBaseballQuota();
  return { ok: true, date, total: fixtures.length, analyzed, skipped, failed, quota, errors: errors.slice(0, 5) };
}
