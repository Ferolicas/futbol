// Contrato durable del resultado MLB. Los null significan "dato no
// disponible"; un cero procedente del boxscore oficial se conserva como cero.

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstKnown(...values) {
  return values.find((value) => value != null) ?? null;
}

function normalizeInnings(innings) {
  if (!Array.isArray(innings) || innings.length === 0) return null;
  return innings.map((inning) => ({
    number: numberOrNull(inning?.number ?? inning?.num),
    home: numberOrNull(inning?.home),
    away: numberOrNull(inning?.away),
  })).filter((inning) => inning.number != null);
}

export function extractMlbTeamResultStats(boxscore, side) {
  const team = boxscore?.teams?.[side];
  const batting = team?.teamStats?.batting;
  const fielding = team?.teamStats?.fielding;
  if (!batting || typeof batting !== 'object') return null;
  return {
    hits: numberOrNull(batting.hits),
    homeRuns: numberOrNull(batting.homeRuns),
    doubles: numberOrNull(batting.doubles),
    triples: numberOrNull(batting.triples),
    strikeouts: numberOrNull(batting.strikeOuts),
    walks: numberOrNull(batting.baseOnBalls),
    stolenBases: numberOrNull(batting.stolenBases),
    leftOnBase: numberOrNull(batting.leftOnBase),
    totalBases: numberOrNull(batting.totalBases),
    rbis: numberOrNull(batting.rbi),
    atBats: numberOrNull(batting.atBats),
    errors: numberOrNull(fielding?.errors),
  };
}

export function buildBaseballResultRow(game, existing = {}, boxscore = null, date, now = new Date()) {
  const providerFinal = game?.isFinal === true;
  const alreadyFinal = existing?.status === 'FT';
  const final = providerFinal || alreadyFinal;
  const live = !final && game?.isLive === true;
  if (!final && !live) return null;

  // Un FT guardado nunca puede regresar a IN/NS por una respuesta transitoria.
  // Si MLB sigue marcando Final, sus correcciones de marcador sí son la fuente
  // autoritativa y pueden reemplazar el snapshot anterior.
  const acceptProviderValues = providerFinal || !alreadyFinal;
  const homeStats = extractMlbTeamResultStats(boxscore, 'home');
  const awayStats = extractMlbTeamResultStats(boxscore, 'away');
  const innings = normalizeInnings(game?.innings);
  const provider = (value, previous) => acceptProviderValues
    ? firstKnown(value, previous)
    : firstKnown(previous, value);

  return {
    fixture_id: Number(game.gamePk),
    league_id: Number(game.sportId || existing.league_id || 1),
    date: date || existing.date || null,
    status: final ? 'FT' : 'IN',
    inning: provider(numberOrNull(game.inning), existing.inning),
    inning_half: provider(game.inningHalf ? String(game.inningHalf).toLowerCase() : null, existing.inning_half),
    home_score: provider(numberOrNull(game.home?.score ?? game.home?.runs), existing.home_score),
    away_score: provider(numberOrNull(game.away?.score ?? game.away?.runs), existing.away_score),
    home_hits: provider(numberOrNull(game.home?.hits ?? homeStats?.hits), existing.home_hits),
    away_hits: provider(numberOrNull(game.away?.hits ?? awayStats?.hits), existing.away_hits),
    home_errors: provider(numberOrNull(game.home?.errors ?? homeStats?.errors), existing.home_errors),
    away_errors: provider(numberOrNull(game.away?.errors ?? awayStats?.errors), existing.away_errors),
    innings: provider(innings, existing.innings),
    home_stats: homeStats || existing.home_stats || null,
    away_stats: awayStats || existing.away_stats || null,
    finished_at: final ? (existing.finished_at || now.toISOString()) : null,
    updated_at: now.toISOString(),
  };
}

export function baseballResultRowChanged(existing, next) {
  if (!next) return false;
  if (!existing?.fixture_id) return true;
  const keys = [
    'league_id', 'date', 'status', 'inning', 'inning_half',
    'home_score', 'away_score', 'home_hits', 'away_hits',
    'home_errors', 'away_errors', 'innings', 'home_stats', 'away_stats',
    'finished_at',
  ];
  return keys.some((key) => JSON.stringify(existing[key] ?? null) !== JSON.stringify(next[key] ?? null));
}

export const baseballResultSnapshotInternals = { numberOrNull, normalizeInnings };
