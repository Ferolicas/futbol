/**
 * POST /api/baseball/analisis
 * Batch-analyze multiple baseball games en una sola peticion. Mantiene
 * sincronia con el job baseball-analyze del worker (cache_version,
 * teamNames, pitcher matchup stub, etc.) para que el upsert sea
 * exactamente equivalente.
 *
 * Body: { fixtures: [{ id, teams, league, country, date, status }], date }
 *
 * Respuesta:
 *   { success, analyzedCount, failedCount, analyses:[...], quota }
 *   Si analyzedCount === 0 → tambien retorna `error` top-level para que
 *   el frontend muestre razon clara al usuario.
 */
import { getBaseballOddsByGame, getBaseballTeamStats, getBaseballH2H, getBaseballQuota } from '../../../../lib/api-baseball';
import { computeBaseballProbabilities, buildBaseballCombinada, scoreBaseballDataQuality, extractBestOdds } from '../../../../lib/baseball-model';
import { calibrateBaseballProbabilities, flattenProbabilitiesForStorage } from '../../../../lib/baseball-calibration';
import { supabaseAdmin } from '../../../../lib/supabase';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Sincronizado con apps/cfanalisis-worker/src/jobs/baseball/analyze.js
const BASEBALL_CACHE_VERSION = 2;

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

    // Pre-check de quota: si no hay margen para al menos un partido completo
    // (4 calls: odds + h2h + 2x stats), abortamos con error claro.
    const quotaPre = await getBaseballQuota();
    if (quotaPre.remaining < 4) {
      return Response.json({
        success: false,
        error: `Cuota diaria de la API de baseball agotada (${quotaPre.used}/${quotaPre.limit}). Vuelve a intentar mañana cuando se reinicie.`,
        quota: quotaPre,
      }, { status: 429 });
    }

    const analyses = [];
    for (const game of fixtures) {
      const fixtureId = game.id;
      if (!fixtureId) {
        analyses.push({ fixtureId: null, success: false, error: 'Fixture sin id' });
        continue;
      }
      try {
        const quota = await getBaseballQuota();
        if (quota.remaining < 4) {
          analyses.push({ fixtureId, success: false, error: `Cuota baja (${quota.remaining}/${quota.limit})` });
          break;
        }

        const homeId = game.teams?.home?.id;
        const awayId = game.teams?.away?.id;
        const leagueId = game.league?.id;
        const homeName = game.teams?.home?.name;
        const awayName = game.teams?.away?.name;

        if (!homeId || !awayId || !leagueId) {
          analyses.push({ fixtureId, success: false, error: `Fixture incompleto: home=${homeId} away=${awayId} league=${leagueId}` });
          continue;
        }

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

        // pitcherMatchup y playerHighlights se dejan null por ahora — el modelo
        // cae al fallback de team-level pitching strength. Cuando se conecte
        // MLB Stats API se llenaran via los stubs en lib/baseball-model.js.
        const rawProbs = computeBaseballProbabilities({
          homeStats, awayStats, homeId, awayId, h2h,
          marketOdds: odds,
          pitcherMatchup: null,
          playerHighlights: null,
        });
        const probs = await calibrateBaseballProbabilities(rawProbs);
        const bestOdds = extractBestOdds(odds);
        // Pasar teamNames para que combinada.selections tengan los nombres
        // reales ("Yankees gana") en vez de placeholders ("Home gana").
        const combinada = buildBaseballCombinada(probs, bestOdds, { home: homeName, away: awayName });
        const dq = scoreBaseballDataQuality({ homeStats, awayStats, h2h, odds, pitcherMatchup: null, playerHighlights: null });

        const { error: upsertErr } = await supabaseAdmin.from('baseball_match_analysis').upsert({
          fixture_id: fixtureId, date, league_id: leagueId,
          league_name: game.league?.name, country: game.country?.name,
          home_team_id: homeId, away_team_id: awayId,
          home_team: homeName, away_team: awayName,
          status: game.status?.short || 'NS',
          start_time: game.date,
          analysis: { homeStats, awayStats, h2h: h2h.slice(0, 10), pitcherMatchup: null, playerHighlights: null },
          odds, best_odds: bestOdds, probabilities: probs, combinada, data_quality: dq,
          cache_version: BASEBALL_CACHE_VERSION,
          updated_at: new Date().toISOString(),
        });
        if (upsertErr) {
          analyses.push({ fixtureId, success: false, error: `DB upsert: ${upsertErr.message}` });
          continue;
        }

        const { error: predErr } = await supabaseAdmin.from('baseball_match_predictions').upsert({
          fixture_id: fixtureId, date, league_id: leagueId,
          home_team_id: homeId, away_team_id: awayId,
          ...flattenProbabilitiesForStorage(probs),
          updated_at: new Date().toISOString(),
        });
        if (predErr) console.warn('[baseball:predictions]', predErr.message);  // no critico

        analyses.push({ fixtureId, success: true, probabilities: probs, combinada });
      } catch (e) {
        analyses.push({ fixtureId, success: false, error: e.message });
      }
    }

    const quota = await getBaseballQuota();
    const analyzedCount = analyses.filter(a => a.success).length;
    const failedCount = analyses.filter(a => !a.success).length;

    // Si TODOS fallaron, devolver error top-level claro al frontend.
    // Antes: respuesta era success:true aunque todos los items fallaran,
    // el dashboard solo leia `data.error` y el usuario veia "no pasa nada".
    const response = { success: analyzedCount > 0, analyses, analyzedCount, failedCount, quota };
    if (analyzedCount === 0) {
      const firstError = analyses.find(a => !a.success)?.error || 'Ningún partido pudo ser analizado';
      response.error = `No se analizó ningún partido. ${firstError}`;
    }
    return Response.json(response);
  } catch (e) {
    console.error('[api/baseball/analisis]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
