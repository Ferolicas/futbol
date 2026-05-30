/**
 * POST /api/baseball/match/[id]/analyze
 *
 * Análisis on-demand de un único juego MLB. Mismo pipeline que el job
 * baseball-analyze del worker, pero para 1 fixture (botón "Re-analizar" del
 * detalle de partido). Fuente: MLB Stats API (gratuita) + The Odds API.
 *
 * Respuesta: { success, fixtureId, probabilities, combinada, dataQuality, cached? }
 */
import {
  getMlbScheduleByDate,
  getMlbPitcherMatchup,
  getMlbTeamSeasonStats,
  toModelTeamStats,
  extractBaseballPlayerHighlights,
} from '../../../../../../lib/mlb-stats-api';
import {
  computeBaseballProbabilities,
  buildBaseballCombinada,
  scoreBaseballDataQuality,
} from '../../../../../../lib/baseball-model';
import {
  calibrateBaseballProbabilities,
  flattenProbabilitiesForStorage,
} from '../../../../../../lib/baseball-calibration';
import { fetchMlbOddsByDate, matchMlbOdds } from '../../../../../../lib/odds-api';
import { supabaseAdmin } from '../../../../../../lib/supabase';
import { createSupabaseServerClient } from '../../../../../../lib/supabase-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BASEBALL_CACHE_VERSION = 3;

function bestOddsShape(odds) {
  if (!odds) return { moneyline: null, totals: {}, runLine: null };
  const totals = {};
  for (const [line, v] of Object.entries(odds.totals || {})) {
    totals[line] = {
      over:  v.over  != null ? { odd: v.over }  : null,
      under: v.under != null ? { odd: v.under } : null,
    };
  }
  return { moneyline: odds.moneyline || null, totals, runLine: odds.runLine || null };
}

// Busca un gamePk MLB en una ventana de fechas (today ±1 cubre cross-midnight).
async function findMlbGame(gamePk) {
  const today = new Date().toISOString().split('T')[0];
  const d = new Date(today + 'T12:00:00Z');
  const dates = [-1, 0, 1].map(off => {
    const x = new Date(d);
    x.setUTCDate(x.getUTCDate() + off);
    return x.toISOString().split('T')[0];
  });
  for (const dt of dates) {
    try {
      const games = await getMlbScheduleByDate(dt, 1);
      const hit = games.find(g => Number(g.gamePk) === Number(gamePk));
      if (hit) return { game: hit, date: dt };
    } catch {}
  }
  return { game: null, date: null };
}

export async function POST(_request, { params }) {
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
    if (!isAdmin && !isActive) {
      return Response.json({ error: 'Subscription required' }, { status: 403 });
    }

    const fixtureId = Number(params.id);
    if (!fixtureId) return Response.json({ error: 'Invalid id' }, { status: 400 });

    // NO degradar: si el cron ya escribió un análisis MLB completa (v3 con
    // player props), devolverlo cacheado en vez de recomputar.
    const { data: existing } = await supabaseAdmin
      .from('baseball_match_analysis')
      .select('probabilities, combinada, data_quality, cache_version, analysis')
      .eq('fixture_id', fixtureId).maybeSingle();
    const versionOk = (existing?.cache_version || 0) >= BASEBALL_CACHE_VERSION;
    if (existing && versionOk && (existing.probabilities?.players || existing.analysis?.pitcherMatchup || existing.analysis?.gamePk)) {
      return Response.json({
        success: true, fixtureId, cached: true,
        probabilities: existing.probabilities, combinada: existing.combinada, dataQuality: existing.data_quality,
      });
    }

    const { game, date } = await findMlbGame(fixtureId);
    if (!game) return Response.json({ error: 'Game not found in MLB Stats API schedule (±1 day window)' }, { status: 404 });

    const season = Number(date.slice(0, 4));
    const homeName = game.home?.name;
    const awayName = game.away?.name;
    const homeId = game.home?.id;
    const awayId = game.away?.id;

    let oddsByTeams = {};
    try {
      const r = await fetchMlbOddsByDate();
      oddsByTeams = r.byTeams || {};
    } catch (e) {
      console.warn('[api/baseball/match/analyze] fetchMlbOddsByDate:', e.message);
    }

    const [matchup, homeTeamRaw, awayTeamRaw, playerHighlights] = await Promise.all([
      getMlbPitcherMatchup(game, season).catch(() => null),
      getMlbTeamSeasonStats(homeId, season, 1).catch(() => null),
      getMlbTeamSeasonStats(awayId, season, 1).catch(() => null),
      extractBaseballPlayerHighlights(game, season).catch(() => null),
    ]);
    const homeStats = toModelTeamStats(homeTeamRaw);
    const awayStats = toModelTeamStats(awayTeamRaw);

    const odds = matchMlbOdds(oddsByTeams, homeName, awayName);
    const bestOdds = bestOddsShape(odds);

    const rawProbs = computeBaseballProbabilities({
      homeStats, awayStats, homeId, awayId,
      h2h: [], marketMoneyline: odds?.moneyline || null,
      pitcherMatchup: matchup, playerHighlights,
    });
    const probs = await calibrateBaseballProbabilities(rawProbs);
    const combinada = buildBaseballCombinada(probs, bestOdds, { home: homeName, away: awayName });
    const dq = scoreBaseballDataQuality({
      homeStats, awayStats, h2h: [], odds: odds ? [odds] : [],
      pitcherMatchup: matchup, playerHighlights,
    });

    await supabaseAdmin.from('baseball_match_analysis').upsert({
      fixture_id: fixtureId, date,
      league_id: 1, league_name: 'MLB', country: 'USA',
      home_team_id: homeId, away_team_id: awayId,
      home_team: homeName, away_team: awayName,
      status: game.status || (game.isFinal ? 'Final' : 'Scheduled'),
      start_time: game.dateUTC,
      analysis: { homeStats, awayStats, pitcherMatchup: matchup, gamePk: game.gamePk },
      odds: odds ? [odds] : [], best_odds: bestOdds,
      probabilities: probs, combinada, data_quality: dq,
      cache_version: BASEBALL_CACHE_VERSION,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'fixture_id' });

    await supabaseAdmin.from('baseball_match_predictions').upsert({
      fixture_id: fixtureId, date, league_id: 1,
      home_team_id: homeId, away_team_id: awayId,
      ...flattenProbabilitiesForStorage(probs),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'fixture_id' });

    return Response.json({ success: true, fixtureId, probabilities: probs, combinada, dataQuality: dq });
  } catch (e) {
    console.error('[api/baseball/match/analyze]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
