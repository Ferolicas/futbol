import { z } from 'zod';
import { supabaseAdmin } from '../../../../lib/supabase';
import { getUserProfile } from '../../../../lib/supabase-auth';
import { jsonError } from '../../../../lib/api-error';
import { getAnalyzedFixtureIds, getAnalyzedMatchesFull } from '../../../../lib/sanity-cache';
import { marketLabel } from '../../../../lib/market-labels';
import { isTelegramMarketAllowed } from '../../../../lib/telegram-daily-pick';
import { isFootballFrontendDailyPickEligible } from '../../../../lib/recommendation-policy';
import { buildBaseballApuestaDelDia } from '../../../../lib/baseball-combinada';
import { marketResultState, settleMarketSelection } from '../../../../lib/market-settlement';
import { MULTISPORT_CACHE_VERSION } from '../../../../lib/multisport-analysis';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tz: z.string().min(1).max(80).optional(),
});

const isFootballPostponed = (status) => ['PST', 'CANC', 'SUSP', 'ABD'].includes(status);

function dayInZone(value, timeZone) {
  if (!value) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(value));
  } catch {
    return new Date(value).toISOString().slice(0, 10);
  }
}

function todayInZone(timeZone) {
  return dayInZone(new Date(), timeZone);
}

function shiftedDate(value, days) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function compactOutcome(outcome) {
  return {
    status: outcome?.status || 'pending',
    settled: outcome?.settled === true,
    observed: outcome?.observed ?? null,
  };
}

function footballSnapshot(row) {
  if (!row) return null;
  return {
    fixtureId: Number(row.fixture_id),
    status: typeof row.status === 'string' ? { short: row.status } : row.status,
    goals: row.goals || null,
    score: row.score || null,
    corners: row.corners ? { ...row.corners, isReal: row.corners.isReal !== false } : null,
    yellowCards: row.yellow_cards ? { ...row.yellow_cards, isReal: row.yellow_cards.isReal !== false } : null,
    redCards: row.red_cards ? { ...row.red_cards, isReal: row.red_cards.isReal !== false } : null,
    goalScorers: row.goal_scorers || [],
    cardEvents: row.card_events || [],
    realFinal: true,
  };
}

function mergeFootballLive(live, result) {
  if (!result) return live || null;
  return {
    ...(live || {}),
    ...result,
    corners: result.corners || live?.corners,
    yellowCards: result.yellowCards || live?.yellowCards,
    redCards: result.redCards || live?.redCards,
    goalScorers: result.goalScorers?.length ? result.goalScorers : (live?.goalScorers || []),
    cardEvents: result.cardEvents?.length ? result.cardEvents : (live?.cardEvents || []),
  };
}

async function footballResults(date, timeZone) {
  const dates = [shiftedDate(date, -1), date, shiftedDate(date, 1)];
  const idLists = await Promise.all(dates.map((value) => getAnalyzedFixtureIds(value)));
  const ids = [...new Set(idLists.flat().map(Number).filter(Number.isFinite))];
  if (!ids.length) return [];

  const [{ analyzedData }, liveResponse, resultResponse] = await Promise.all([
    getAnalyzedMatchesFull(ids),
    supabaseAdmin.from('match_analysis')
      .select('fixture_id,live_stats,created_at')
      .in('fixture_id', ids)
      .order('created_at', { ascending: false }),
    supabaseAdmin.from('match_results')
      .select('fixture_id,status,goals,score,corners,yellow_cards,red_cards,goal_scorers,card_events,created_at')
      .in('fixture_id', ids),
  ]);

  const latestLive = new Map();
  for (const row of (liveResponse.data || [])) {
    if (!latestLive.has(String(row.fixture_id)) && row.live_stats) latestLive.set(String(row.fixture_id), row.live_stats);
  }
  const finals = new Map((resultResponse.data || []).map((row) => [String(row.fixture_id), footballSnapshot(row)]));
  const matches = [];

  for (const [fixtureId, data] of Object.entries(analyzedData || {})) {
    if (data?.kickoff && dayInZone(data.kickoff, timeZone) !== date) continue;
    const live = mergeFootballLive(latestLive.get(String(fixtureId)), finals.get(String(fixtureId)));
    const status = live?.status || data?.status || { short: 'NS' };
    const short = typeof status === 'string' ? status : status?.short;
    if (isFootballPostponed(short)) continue;
    const game = {
      fixture: { id: Number(fixtureId), date: data?.kickoff, status },
      teams: {
        home: { id: data?.homeId, name: data?.homeTeam || 'Local', logo: data?.homeLogo },
        away: { id: data?.awayId, name: data?.awayTeam || 'Visitante', logo: data?.awayLogo },
      },
      goals: live?.goals || data?.goals || null,
      score: live?.score || data?.score || null,
    };
    const state = marketResultState({ sport: 'football', game, liveResult: live });
    if (!state.isLive && !state.isFinal) continue;
    const selectable = data?.combinada?.source === 'context-engine'
      ? (data.combinada.selectable || data.combinada.selections || [])
      : [];
    const selections = selectable
      .filter(isTelegramMarketAllowed)
      .filter(isFootballFrontendDailyPickEligible)
      .map((selection) => ({
        id: selection.id,
        name: selection.scope === 'context'
          ? marketLabel(selection.id, { home: data?.homeTeam, away: data?.awayTeam })
          : selection.name,
        probability: Number(selection.rawProbability ?? selection.probability),
        odd: Number(selection.odd),
        outcome: compactOutcome(settleMarketSelection({ sport: 'football', selection, game, liveResult: live })),
      }));
    if (!selections.length) continue;
    matches.push({
      fixtureId: String(fixtureId), sport: 'Fútbol', kickoff: data?.kickoff || null,
      league: typeof data?.league === 'string' ? data.league : (data?.league?.name || null),
      matchName: `${data?.homeTeam || 'Local'} vs ${data?.awayTeam || 'Visitante'}`,
      status: state.status, isLive: state.isLive, isFinal: state.isFinal, selections,
    });
  }
  return matches;
}

async function baseballResults(date, timeZone) {
  const start = new Date(`${shiftedDate(date, -1)}T00:00:00Z`).toISOString();
  const end = new Date(`${shiftedDate(date, 2)}T00:00:00Z`).toISOString();
  const { data: rows, error } = await supabaseAdmin.from('baseball_match_analysis')
    .select('fixture_id,date,league_name,home_team,away_team,status,start_time,combinada,cache_version')
    .gte('start_time', start)
    .lt('start_time', end)
    .gte('cache_version', MULTISPORT_CACHE_VERSION);
  if (error) throw error;
  const dayRows = (rows || []).filter((row) => dayInZone(row.start_time, timeZone) === date);
  const ids = dayRows.map((row) => Number(row.fixture_id)).filter(Number.isFinite);
  if (!ids.length) return [];
  const { data: results, error: resultsError } = await supabaseAdmin.from('baseball_match_results')
    .select('fixture_id,status,inning,inning_half,home_score,away_score,home_hits,away_hits,home_errors,away_errors,innings,home_stats,away_stats,finished_at')
    .in('fixture_id', ids);
  if (resultsError) throw resultsError;
  const byId = new Map((results || []).map((row) => [String(row.fixture_id), row]));
  const games = dayRows.map((row) => {
    const result = byId.get(String(row.fixture_id)) || null;
    return {
      id: Number(row.fixture_id), date: row.start_time,
      league: { name: row.league_name },
      teams: { home: { name: row.home_team }, away: { name: row.away_team } },
      status: { short: result?.status || row.status || 'NS' },
      scores: { home: { total: result?.home_score }, away: { total: result?.away_score } },
      analysis: { combinada: row.combinada }, liveResult: result,
    };
  });
  const apuesta = buildBaseballApuestaDelDia(games);
  if (!apuesta) return [];
  const gameMap = new Map(games.map((game) => [String(game.id), game]));
  const grouped = new Map();
  for (const selection of apuesta.selections || []) {
    const game = gameMap.get(String(selection.fixtureId));
    const state = marketResultState({ sport: 'baseball', game });
    if (!state.isLive && !state.isFinal) continue;
    const key = String(selection.fixtureId);
    if (!grouped.has(key)) grouped.set(key, {
      fixtureId: key, sport: 'Béisbol', kickoff: game?.date || null,
      league: game?.league?.name || null, matchName: selection.matchName,
      status: state.status, isLive: state.isLive, isFinal: state.isFinal, selections: [],
    });
    grouped.get(key).selections.push({
      id: selection.id || selection.marketKey,
      name: selection.name || selection.market,
      probability: Number(selection.rawProbability ?? selection.probability),
      odd: Number(selection.odd),
      outcome: compactOutcome(settleMarketSelection({ sport: 'baseball', selection, game })),
    });
  }
  return [...grouped.values()];
}

function summarize(date, timeZone, matches) {
  const ordered = [...matches].sort((left, right) => new Date(left.kickoff || 0) - new Date(right.kickoff || 0));
  let cumulativeWon = 0;
  let cumulativeSettled = 0;
  const curve = [{ label: 'Inicio', won: 0, settled: 0 }];
  for (const match of ordered) {
    const won = match.selections.filter((selection) => selection.outcome.status === 'won').length;
    const lost = match.selections.filter((selection) => selection.outcome.status === 'lost').length;
    cumulativeWon += won;
    cumulativeSettled += won + lost;
    const time = match.kickoff
      ? new Date(match.kickoff).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone })
      : match.sport;
    curve.push({ label: time, won: cumulativeWon, settled: cumulativeSettled, fixtureId: match.fixtureId });
  }
  const selections = ordered.flatMap((match) => match.selections);
  const won = selections.filter((selection) => selection.outcome.status === 'won').length;
  const lost = selections.filter((selection) => selection.outcome.status === 'lost').length;
  const pending = selections.filter((selection) => !['won', 'lost'].includes(selection.outcome.status)).length;
  return {
    date, timeZone,
    totals: {
      won, lost, pending, total: selections.length,
      accuracy: won + lost ? Math.round((won / (won + lost)) * 10_000) / 100 : 0,
    },
    curve,
    matches: ordered,
    updatedAt: new Date().toISOString(),
  };
}

export async function GET(request) {
  const profile = await getUserProfile();
  if (!profile || !['admin', 'owner'].includes(profile.role)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: 'Consulta inválida' }, { status: 400 });
  const timeZone = parsed.data.tz || 'Europe/Madrid';
  try {
    new Intl.DateTimeFormat('es-ES', { timeZone }).format(new Date());
  } catch {
    return Response.json({ error: 'Zona horaria inválida' }, { status: 400 });
  }
  const date = parsed.data.date || todayInZone(timeZone);
  try {
    const [football, baseball] = await Promise.all([
      footballResults(date, timeZone),
      baseballResults(date, timeZone),
    ]);
    return Response.json(summarize(date, timeZone, [...football, ...baseball]));
  } catch (error) {
    console.error('[admin/daily-pick-results]', error);
    return jsonError(error);
  }
}
