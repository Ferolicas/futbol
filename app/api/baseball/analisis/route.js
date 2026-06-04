/**
 * POST /api/baseball/analisis
 *
 * Batch-analyze on-demand de juegos MLB. Espejo del job `baseball-analyze` del
 * worker (apps/cfanalisis-worker/src/jobs/baseball/analyze.js) pero invocable
 * desde el dashboard. Usa MLB Stats API como fuente única (pitcher matchup,
 * team stats, player highlights) + The Odds API para cuotas (filtradas a
 * bet365/bwin en lib/odds-api.js).
 *
 * Body: { fixtures: [{ id }], date?: 'YYYY-MM-DD' }
 *   Solo necesitamos `id` (gamePk MLB). El resto se reconstruye desde MLB Stats
 *   API (single source of truth), evitando inconsistencias con lo que mande la UI.
 *
 * Respuesta: { success, analyses:[...], analyzedCount, failedCount, quota, error? }
 *   Shape sin cambios respecto a la versión legacy con api-sports.
 */
import {
  getMlbScheduleByDate,
  getMlbPitcherMatchup,
  getMlbTeamSeasonStats,
  toModelTeamStats,
  extractBaseballPlayerHighlights,
} from '../../../../lib/mlb-stats-api';
import {
  computeBaseballProbabilities,
  buildBaseballCombinada,
  scoreBaseballDataQuality,
} from '../../../../lib/baseball-model';
import {
  calibrateBaseballProbabilities,
  flattenProbabilitiesForStorage,
} from '../../../../lib/baseball-calibration';
import { fetchMlbOddsByDate, matchMlbOdds } from '../../../../lib/odds-api';
import { redisGet } from '../../../../lib/redis';
import { supabaseAdmin } from '../../../../lib/supabase';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { jsonError } from '../../../../lib/api-error';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Sync con apps/cfanalisis-worker/src/jobs/baseball/analyze.js — cuando se
// cambie allí, cambiar acá. v3 = MLB Stats API + pitcher matchup + player props.
const BASEBALL_CACHE_VERSION = 3;
const ODDS_DAILY_CAP = 15;

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

async function readOddsQuota() {
  const date = new Date().toISOString().split('T')[0];
  let used = 0;
  try { used = Number(await redisGet(`theodds:req:${date}`)) || 0; } catch {}
  return { used, limit: ODDS_DAILY_CAP, remaining: Math.max(0, ODDS_DAILY_CAP - used), date, source: 'the-odds-api' };
}

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

    const season = Number(date.slice(0, 4));

    // Mapa fixtureId → MLB game completo. Pedimos el schedule del día UNA vez
    // (cubre cross-midnight: si el cliente manda un id de día anterior con un
    // live activo, MLB lo devuelve aún en su schedule). Si quedan ids sin
    // encontrar, pedimos día siguiente/anterior.
    const wantedIds = new Set(fixtures.map(f => Number(f.id)).filter(Boolean));
    const gamesById = new Map();
    const dayOffsets = [0, -1, 1];
    for (const off of dayOffsets) {
      if (gamesById.size >= wantedIds.size) break;
      const d = new Date(date + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() + off);
      const dStr = d.toISOString().split('T')[0];
      try {
        const games = await getMlbScheduleByDate(dStr, 1);
        for (const g of games) {
          if (wantedIds.has(Number(g.gamePk)) && !gamesById.has(Number(g.gamePk))) {
            gamesById.set(Number(g.gamePk), g);
          }
        }
      } catch {}
    }

    // Cuotas del día (1 sola llamada con cache 3h en redis).
    let oddsByTeams = {};
    try {
      const r = await fetchMlbOddsByDate();
      oddsByTeams = r.byTeams || {};
    } catch (e) {
      console.warn('[api/baseball/analisis] fetchMlbOddsByDate:', e.message);
    }

    const analyses = [];
    for (const fx of fixtures) {
      const fixtureId = Number(fx.id);
      if (!fixtureId) {
        analyses.push({ fixtureId: null, success: false, error: 'Fixture sin id' });
        continue;
      }

      try {
        // NO degradar: si el cron ya escribió un análisis MLB completo
        // (player props, pitcher matchup), devolverlo cacheado.
        const { data: existing } = await supabaseAdmin
          .from('baseball_match_analysis')
          .select('probabilities, combinada, cache_version, analysis')
          .eq('fixture_id', fixtureId).maybeSingle();
        const versionOk = (existing?.cache_version || 0) >= BASEBALL_CACHE_VERSION;
        if (existing && versionOk && (existing.probabilities?.players || existing.analysis?.pitcherMatchup || existing.analysis?.gamePk)) {
          analyses.push({ fixtureId, success: true, cached: true, probabilities: existing.probabilities, combinada: existing.combinada });
          continue;
        }

        const game = gamesById.get(fixtureId);
        if (!game) {
          analyses.push({ fixtureId, success: false, error: 'Game not found in MLB Stats API schedule (±1 day window)' });
          continue;
        }

        const homeName = game.home?.name;
        const awayName = game.away?.name;
        const homeId = game.home?.id;
        const awayId = game.away?.id;

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

        const { error: upsertErr } = await supabaseAdmin.from('baseball_match_analysis').upsert({
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
        if (upsertErr) {
          analyses.push({ fixtureId, success: false, error: `DB upsert: ${upsertErr.message}` });
          continue;
        }

        const { error: predErr } = await supabaseAdmin.from('baseball_match_predictions').upsert({
          fixture_id: fixtureId, date, league_id: 1,
          home_team_id: homeId, away_team_id: awayId,
          ...flattenProbabilitiesForStorage(probs),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'fixture_id' });
        if (predErr) console.warn('[api/baseball/analisis] predictions fail (no critico):', predErr.message);

        analyses.push({ fixtureId, success: true, probabilities: probs, combinada });
      } catch (e) {
        analyses.push({ fixtureId, success: false, error: e.message });
      }
    }

    const quota = await readOddsQuota();
    const analyzedCount = analyses.filter(a => a.success).length;
    const failedCount = analyses.filter(a => !a.success).length;

    const response = { success: analyzedCount > 0, analyses, analyzedCount, failedCount, quota };
    if (analyzedCount === 0) {
      const firstError = analyses.find(a => !a.success)?.error || 'Ningún partido pudo ser analizado';
      response.error = `No se analizó ningún partido. ${firstError}`;
    }
    return Response.json(response);
  } catch (e) {
    console.error('[api/baseball/analisis]', e.message);
    return jsonError(e);
  }
}
