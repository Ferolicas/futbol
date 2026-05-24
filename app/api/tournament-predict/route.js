/**
 * GET /api/tournament-predict?league=2&season=2026
 *
 * Devuelve probabilidades Monte Carlo de campeon/finalista/semifinalistas
 * para una copa eliminatoria. Solo aplica a torneos con bracket knockout.
 *
 * Pre-requisitos:
 *   - league_id debe estar en TOURNAMENT_LEAGUES (champions, europa, copa
 *     libertadores, etc.)
 *   - match_predictions debe tener filas para las eliminatorias restantes
 *     (idealmente con predictions_full ya populado tras Fase 4 calibration).
 *
 * Query params:
 *   league      — leagueId (required)
 *   season      — season year (default: temporada actual)
 *   iterations  — Monte Carlo iterations (default 10000, max 50000)
 *
 * Response:
 *   {
 *     league: { id, name },
 *     iterations,
 *     champion:  { [teamId]: { team: {id,name,logo}, probability } },
 *     finalist:  { ... },
 *     semis:     { ... }
 *   }
 */

import { supabaseAdmin } from '../../../lib/supabase';
import { simulateBracket } from '../../../lib/tournament-bracket';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Torneos donde la simulacion tiene sentido (knockout/copa).
const TOURNAMENT_LEAGUES = new Set([
  1,    // FIFA World Cup
  2,    // UEFA Champions League
  3,    // UEFA Europa League
  848,  // UEFA Conference League
  11,   // CONMEBOL Sudamericana
  13,   // CONMEBOL Libertadores
  26,   // CONCACAF Champions Cup
  17,   // AFC Champions League
  12,   // CAF Champions League
  16,   // FIFA Club World Cup
  45,   // FA Cup
  143,  // Copa del Rey
  81,   // DFB Pokal
  137,  // Coppa Italia
  66,   // Coupe de France
  130,  // Copa Argentina
  131,  // Copa de la Superliga
  73,   // Copa Betano (Brazil)
  241,  // Copa Colombia
  147,  // Beker van België
  90,   // KNVB Beker
  156,  // Türkiye Kupası
  96,   // Taça de Portugal
  20,   // CAF Confederation Cup
]);

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const leagueId   = Number(searchParams.get('league'));
  const seasonArg  = searchParams.get('season');
  const iterations = Math.min(50000, Math.max(1000, Number(searchParams.get('iterations')) || 10000));

  if (!leagueId) {
    return Response.json({ error: 'league param required' }, { status: 400 });
  }
  if (!TOURNAMENT_LEAGUES.has(leagueId)) {
    return Response.json({
      error: 'league not supported for bracket simulation',
      hint: 'Solo torneos knockout (Champions, Europa, Libertadores, copas nacionales). Ligas regulares no aplican.',
    }, { status: 400 });
  }

  const season = seasonArg ? Number(seasonArg) : new Date().getFullYear();

  // Fetch eliminatorias pendientes (NS o live) del torneo
  const { data: matches, error } = await supabaseAdmin
    .from('match_predictions')
    .select('fixture_id, league_id, league_name, home_team, away_team, kickoff, p_home_win, p_draw, p_away_win')
    .eq('league_id', leagueId);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  if (!matches || matches.length === 0) {
    return Response.json({
      error: 'no matches found for this league',
      hint: 'Asegurate de que match_predictions tiene filas para esta liga. Si la liga es muy nueva, espera al proximo daily cron.',
    }, { status: 404 });
  }

  // Construir bracket — agrupar matches PENDIENTES por round (vamos a usar
  // round string del fixture; si la API no lo da, asumimos round actual).
  // Para simplificar la primera version, usamos TODOS los matches como
  // "round 0" — la simulacion los procesa lineal y agregar resultados.
  const bracket = matches.map(m => ({
    fixtureId: m.fixture_id,
    teamA: m.home_team,
    teamB: m.away_team,
  }));

  // Mapa de predictions por fixture_id
  const predictionsMap = new Map();
  for (const m of matches) {
    predictionsMap.set(m.fixture_id, {
      p_home_win: m.p_home_win,
      p_draw:     m.p_draw,
      p_away_win: m.p_away_win,
    });
  }

  const result = simulateBracket(bracket, predictionsMap, iterations);

  return Response.json({
    league: { id: leagueId, name: matches[0]?.league_name || 'Unknown' },
    season,
    matchCount: matches.length,
    ...result,
  });
}
