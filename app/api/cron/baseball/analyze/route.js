/**
 * GET /api/cron/baseball/analyze
 * Analyzes today's baseball games: fetches odds + stats + h2h, computes probabilities,
 * applies calibration, stores analysis. Inserts row in baseball_match_predictions
 * for later calibration training.
 *
 * Strategy under tight quota (100/day):
 *   - Cron runs once at 03:30 Spain (after fixtures cron).
 *   - For each game: 1 odds call, 1 standings call (cached), 1 H2H call (cached).
 *   - Skips games already analyzed today.
 *
 * Schedule: "30 1 * * *"  (UTC 01:30 = Spain 03:30)
 */
import { getBaseballFixturesByDate, getBaseballOddsByGame, getBaseballTeamStats, getBaseballH2H, getBaseballQuota } from '../../../../../lib/api-baseball';
import { computeBaseballProbabilities, buildBaseballCombinada, scoreBaseballDataQuality, extractBestOdds } from '../../../../../lib/baseball-model';
import { calibrateBaseballProbabilities, flattenProbabilitiesForStorage } from '../../../../../lib/baseball-calibration';
import { supabaseAdmin } from '../../../../../lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function verifyAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret') || request.headers.get('authorization')?.replace('Bearer ', '');
  return secret === process.env.CRON_SECRET || process.env.NODE_ENV !== 'production';
}

export async function GET(request) {
  if (!verifyAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date') || new Date().toISOString().split('T')[0];

    const { fixtures } = await getBaseballFixturesByDate(date);
    if (!fixtures || fixtures.length === 0) {
      return Response.json({ success: true, analyzed: 0, message: 'No fixtures' });
    }

    const results = [];
    let analyzed = 0;
    let skipped = 0;
    let failed = 0;

    for (const game of fixtures) {
      const fixtureId = game.id;
      try {
        // Skip if already analyzed today
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

        // Quota guard
        const quota = await getBaseballQuota();
        if (quota.remaining < 5) {
          console.log(`[CRON:baseball/analyze] Quota low (${quota.remaining}), stopping`);
          break;
        }

        const homeId = game.teams?.home?.id;
        const awayId = game.teams?.away?.id;
        const leagueId = game.league?.id;

        // Parallel: odds + h2h + team stats (3 API calls)
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

        // Persist analysis
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

        // Persist prediction row for calibration
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
        console.error(`[CRON:baseball/analyze] fixture ${fixtureId}:`, e.message);
        failed++;
        results.push({ fixtureId, error: e.message });
        if (e.message.startsWith('BASEBALL_QUOTA_EXHAUSTED')) break;
      }
    }

    const quota = await getBaseballQuota();
    return Response.json({
      success: true,
      date,
      total: fixtures.length,
      analyzed,
      skipped,
      failed,
      quota,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[CRON:baseball/analyze]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
