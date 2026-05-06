/**
 * POST /api/baseball/match/[id]/analyze
 * On-demand analysis trigger (admin or for missing analyses).
 * Same logic as the analyze cron but for a single game.
 */
import { getBaseballGameById, getBaseballOddsByGame, getBaseballTeamStats, getBaseballH2H, getBaseballQuota } from '../../../../../../lib/api-baseball';
import { computeBaseballProbabilities, buildBaseballCombinada, scoreBaseballDataQuality, extractBestOdds } from '../../../../../../lib/baseball-model';
import { calibrateBaseballProbabilities, flattenProbabilitiesForStorage } from '../../../../../../lib/baseball-calibration';
import { supabaseAdmin } from '../../../../../../lib/supabase';
import { createSupabaseServerClient } from '../../../../../../lib/supabase-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(_request, { params }) {
  try {
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // Only active subscribers or admins/owners
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('role, subscription_status')
      .eq('id', user.id)
      .single();
    const isAdmin = ['admin', 'owner'].includes(profile?.role);
    const isActive = ['active', 'trialing'].includes(profile?.subscription_status);
    if (!isAdmin && !isActive) {
      return Response.json({ error: 'Subscription required' }, { status: 403 });
    }

    const fixtureId = Number(params.id);
    if (!fixtureId) return Response.json({ error: 'Invalid id' }, { status: 400 });

    const quota = await getBaseballQuota();
    if (quota.remaining < 4) {
      return Response.json({ error: 'API quota too low for analysis', quota }, { status: 429 });
    }

    const { game } = await getBaseballGameById(fixtureId);
    if (!game) return Response.json({ error: 'Game not found' }, { status: 404 });

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

    const rawProbs = computeBaseballProbabilities({ homeStats, awayStats, homeId, awayId, h2h, marketOdds: odds });
    const probs = await calibrateBaseballProbabilities(rawProbs);
    const bestOdds = extractBestOdds(odds);
    const combinada = buildBaseballCombinada(probs, bestOdds);
    const dq = scoreBaseballDataQuality({ homeStats, awayStats, h2h, odds });

    const date = (game.date || new Date().toISOString()).split('T')[0];
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

    return Response.json({ success: true, fixtureId, probabilities: probs, combinada, dataQuality: dq });
  } catch (e) {
    console.error('[api/baseball/match/analyze]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
