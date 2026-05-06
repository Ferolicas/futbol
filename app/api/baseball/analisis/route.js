/**
 * POST /api/baseball/analisis
 * Batch-analyze multiple baseball games in one call. Mirrors /api/analisis.
 * Body: { fixtures: [{ id, teams, league, country, date, status }], date }
 */
import { getBaseballOddsByGame, getBaseballTeamStats, getBaseballH2H, getBaseballQuota } from '../../../../lib/api-baseball';
import { computeBaseballProbabilities, buildBaseballCombinada, scoreBaseballDataQuality, extractBestOdds } from '../../../../lib/baseball-model';
import { calibrateBaseballProbabilities, flattenProbabilitiesForStorage } from '../../../../lib/baseball-calibration';
import { supabaseAdmin } from '../../../../lib/supabase';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request) {
  try {
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('role, subscription_status')
      .eq('id', user.id).single();
    const isAdmin = ['admin', 'owner'].includes(profile?.role);
    const isActive = ['active', 'trialing'].includes(profile?.subscription_status);
    if (!isAdmin && !isActive) return Response.json({ error: 'Subscription required' }, { status: 403 });

    const body = await request.json();
    const fixtures = body.fixtures || [];
    const date = body.date || new Date().toISOString().split('T')[0];
    if (fixtures.length === 0) return Response.json({ error: 'No fixtures' }, { status: 400 });

    const analyses = [];
    for (const game of fixtures) {
      const fixtureId = game.id;
      try {
        const quota = await getBaseballQuota();
        if (quota.remaining < 4) {
          analyses.push({ fixtureId, success: false, error: 'Quota too low' });
          break;
        }

        const homeId = game.teams?.home?.id;
        const awayId = game.teams?.away?.id;
        const leagueId = game.league?.id;

        const [oddsR, h2hR, hStR, aStR] = await Promise.allSettled([
          getBaseballOddsByGame(fixtureId),
          getBaseballH2H(homeId, awayId),
          getBaseballTeamStats(homeId, leagueId),
          getBaseballTeamStats(awayId, leagueId),
        ]);
        const odds = oddsR.status === 'fulfilled' ? oddsR.value.odds : [];
        const h2h = h2hR.status === 'fulfilled' ? h2hR.value.h2h : [];
        const homeStats = hStR.status === 'fulfilled' ? hStR.value.stats : null;
        const awayStats = aStR.status === 'fulfilled' ? aStR.value.stats : null;

        const rawProbs = computeBaseballProbabilities({ homeStats, awayStats, homeId, awayId, h2h, marketOdds: odds });
        const probs = await calibrateBaseballProbabilities(rawProbs);
        const bestOdds = extractBestOdds(odds);
        const combinada = buildBaseballCombinada(probs, bestOdds);
        const dq = scoreBaseballDataQuality({ homeStats, awayStats, h2h, odds });

        await supabaseAdmin.from('baseball_match_analysis').upsert({
          fixture_id: fixtureId, date, league_id: leagueId,
          league_name: game.league?.name, country: game.country?.name,
          home_team_id: homeId, away_team_id: awayId,
          home_team: game.teams?.home?.name, away_team: game.teams?.away?.name,
          status: game.status?.short || 'NS',
          start_time: game.date,
          analysis: { homeStats, awayStats, h2h: h2h.slice(0, 10) },
          odds, best_odds: bestOdds, probabilities: probs, combinada, data_quality: dq,
          updated_at: new Date().toISOString(),
        });
        await supabaseAdmin.from('baseball_match_predictions').upsert({
          fixture_id: fixtureId, date, league_id: leagueId,
          home_team_id: homeId, away_team_id: awayId,
          ...flattenProbabilitiesForStorage(probs),
          updated_at: new Date().toISOString(),
        });

        analyses.push({ fixtureId, success: true, probabilities: probs, combinada });
      } catch (e) {
        analyses.push({ fixtureId, success: false, error: e.message });
      }
    }

    const quota = await getBaseballQuota();
    return Response.json({
      success: true,
      analyses,
      analyzedCount: analyses.filter(a => a.success).length,
      failedCount: analyses.filter(a => !a.success).length,
      quota,
    });
  } catch (e) {
    console.error('[api/baseball/analisis]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
