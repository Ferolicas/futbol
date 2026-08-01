import { pgPool } from './db.js';
import { getMultisportConfig, getSportCompetition, getSportCompetitions, isIsoDate } from './multisport-config.js';
import { getSportGameDetails, getSportGamesByDate, getSportOdds } from './multisport-providers.js';
import {
  buildEmpiricalPlayerProbabilities,
  computeMultisportEmpiricalPrediction,
  toBaseballProbabilityShape,
  validationSupportsDisplayedProbability,
} from './multisport-empirical-engine.js';
import {
  getSportAnalyses,
  ingestFinalSportGame,
  persistSportGames,
  persistSportSchedule,
  saveSportAnalysis,
  saveSportPrediction,
} from './multisport-store.js';
import { extractBaseballPlayerHighlights, getMlbPitcherMatchup } from './mlb-stats-api.js';

const CACHE_VERSION = 10; // primer contrato empírico multi-deporte

function lineKey(value) {
  return String(value).replace('-', 'm').replace('.', '_');
}

function validationEntry(prediction, key) {
  const metrics = prediction?.engine?.validation;
  return metrics?.validation?.[key] || metrics?.candidate?.markets?.[key] || metrics?.markets?.[key] || null;
}

function validationAllows(prediction, key, probability, threshold = 0.8) {
  const entry = validationEntry(prediction, key);
  return validationSupportsDisplayedProbability(entry, probability, threshold);
}

function oddValue(entry) {
  if (entry == null) return null;
  const value = Number(typeof entry === 'object' ? entry.odd : entry);
  return Number.isFinite(value) && value >= 1.2 ? value : null;
}

function probabilityValue(entry) {
  const value = Number(entry?.probability ?? entry);
  return Number.isFinite(value) ? value : null;
}

export function buildMultisportCombinada(prediction, odds, game, options = {}) {
  const config = getMultisportConfig(prediction.sport);
  const candidates = [];
  const add = ({ id, category, name, probability, odd, validationKey }) => {
    const p = probabilityValue(probability);
    const o = oddValue(odd);
    if (p == null || !o || p < (options.selectableThreshold || 80)) return;
    if (!validationAllows(prediction, validationKey, p, (options.validationThreshold || 80) / 100)) return;
    candidates.push({ id, category, market: category, name, pick: name, probability: p, odd: o, validationKey, validated: true });
  };

  add({ id: 'ml-home', category: 'moneyline', name: `${game.teams.home.name} gana`, probability: prediction.moneyline?.home, odd: odds?.moneyline?.home, validationKey: 'moneyline_home' });
  add({ id: 'ml-away', category: 'moneyline', name: `${game.teams.away.name} gana`, probability: prediction.moneyline?.away, odd: odds?.moneyline?.away, validationKey: 'moneyline_away' });
  if (config.drawAllowed) add({ id: 'ml-draw', category: 'moneyline', name: 'Empate', probability: prediction.moneyline?.draw, odd: odds?.moneyline?.draw, validationKey: 'moneyline_draw' });

  for (const [line, values] of Object.entries(prediction.totals?.lines || {})) {
    add({ id: `total-${line}-over`, category: `total-${line}`, name: `Más de ${line} ${config.scoreLabel}`, probability: values.over, odd: odds?.totals?.[line]?.over, validationKey: `total_over_${lineKey(line)}` });
    add({ id: `total-${line}-under`, category: `total-${line}`, name: `Menos de ${line} ${config.scoreLabel}`, probability: values.under, odd: odds?.totals?.[line]?.under, validationKey: `total_under_${lineKey(line)}` });
  }

  // Un resultado por categoría evita recomendar simultáneamente dos líneas
  // correlacionadas del mismo mercado.
  const bestByCategory = new Map();
  for (const item of candidates) {
    const previous = bestByCategory.get(item.category);
    if (!previous || item.probability > previous.probability) bestByCategory.set(item.category, item);
  }
  const selectable = [...bestByCategory.values()].sort((a, b) => b.probability - a.probability || b.odd - a.odd);
  const selections = selectable.filter((item) => item.probability >= (options.highlightThreshold || 90)).slice(0, 3);
  const combinedOdd = selections.length ? selections.reduce((value, item) => value * item.odd, 1) : null;
  const combinedProbability = selections.length ? selections.reduce((value, item) => value * (item.probability / 100), 1) * 100 : 0;
  return {
    selections,
    selectable,
    combinedOdd: combinedOdd == null ? null : Math.round(combinedOdd * 100) / 100,
    combinedProbability: Math.round(combinedProbability * 10) / 10,
    hasRealOdds: selectable.length > 0,
    source: 'empirical-validated',
    awaitingValidation: selectable.length === 0 && !prediction.engine?.validation,
  };
}

function baseballOddsShape(odds) {
  const totals = Object.fromEntries(Object.entries(odds?.totals || {}).map(([line, value]) => [line, {
    over: value.over ? { odd: oddValue(value.over), bookmaker: value.over.bookmaker } : null,
    under: value.under ? { odd: oddValue(value.under), bookmaker: value.under.bookmaker } : null,
  }]));
  const line = 1.5;
  return {
    ...odds,
    moneyline: {
      home: oddValue(odds?.moneyline?.home),
      away: oddValue(odds?.moneyline?.away),
    },
    totals,
    runLine: {
      home_minus_1_5: odds?.spreads?.home?.[-line]?.odd || null,
      home_plus_1_5: odds?.spreads?.home?.[line]?.odd || null,
      away_minus_1_5: odds?.spreads?.away?.[-line]?.odd || null,
      away_plus_1_5: odds?.spreads?.away?.[line]?.odd || null,
    },
  };
}

function dataQuality(prediction, odds, details) {
  const homeSamples = Number(prediction.engine?.samples?.homeTeam || 0);
  const awaySamples = Number(prediction.engine?.samples?.awayTeam || 0);
  const hasOdds = Object.keys(odds?.moneyline || {}).length > 0 || Object.keys(odds?.totals || {}).length > 0;
  const hasDetail = !!details;
  const checks = { hasHomeHistory: homeSamples > 0, hasAwayHistory: awaySamples > 0, hasOdds, hasDetail, hasValidation: !!prediction.engine?.validation };
  const score = Math.round(Object.values(checks).filter(Boolean).length / Object.keys(checks).length * 100);
  return {
    ...checks, homeSamples, awaySamples, score,
    // Alias del contrato visual de Baseball. Son trazabilidad, no factores que
    // alteren la probabilidad.
    hasHomeStats: checks.hasHomeHistory,
    hasAwayStats: checks.hasAwayHistory,
    hasH2H: false,
    hasPitcherMatchup: !!details?.pitcherMatchup,
    hasPlayerHighlights: !!details?.playerHighlights,
  };
}

export async function analyzeSportGame(sport, game, options = {}) {
  const config = getMultisportConfig(sport);
  let odds = { moneyline: {}, totals: {}, spreads: {}, periods: {}, rawBookmakers: [], source: `api-${config.oddsProvider}` };
  try { odds = await getSportOdds(config.key, game, { ttl: options.oddsTtl }); }
  catch (error) { console.warn(`[${config.key}:odds] ${game.id}: ${error.message}`); }

  let pitcherMatchup = null;
  let playerHighlights = null;
  let details = null;
  const fixture = { ...game, context: { home: {}, away: {} } };
  if (config.key === 'baseball' && String(game.league?.id || '1') === '1') {
    const season = Number(String(game.season).slice(0, 4));
    [pitcherMatchup, playerHighlights] = await Promise.all([
      getMlbPitcherMatchup({
        gamePk: Number(game.providerFixtureId),
        home: { ...game.teams.home, probablePitcherId: game.teams.home.probablePitcherId, probablePitcherName: game.teams.home.probablePitcherName },
        away: { ...game.teams.away, probablePitcherId: game.teams.away.probablePitcherId, probablePitcherName: game.teams.away.probablePitcherName },
      }, season).catch(() => null),
      extractBaseballPlayerHighlights({
        gamePk: Number(game.providerFixtureId),
        home: { ...game.teams.home, probablePitcherId: game.teams.home.probablePitcherId, probablePitcherName: game.teams.home.probablePitcherName },
        away: { ...game.teams.away, probablePitcherId: game.teams.away.probablePitcherId, probablePitcherName: game.teams.away.probablePitcherName },
      }, season).catch(() => null),
    ]);
    fixture.context.home.starterId = game.teams.home.probablePitcherId || null;
    fixture.context.away.starterId = game.teams.away.probablePitcherId || null;
    fixture.context.home.starters = playerHighlights?.context?.homeStarters || [];
    fixture.context.away.starters = playerHighlights?.context?.awayStarters || [];
    details = { pitcherMatchup, playerHighlights };
  }

  const prediction = await computeMultisportEmpiricalPrediction(pgPool, { sport: config.key, fixture, odds });
  const genericCombinada = buildMultisportCombinada(prediction, odds, game);
  const playerProbabilities = buildEmpiricalPlayerProbabilities(playerHighlights);
  const probabilities = config.key === 'baseball'
    ? toBaseballProbabilityShape(prediction, { playerHighlights, playerProbabilities, pitcherMatchup })
    : prediction;
  // El shape de baseball conserva sus nombres visuales; las selecciones siguen
  // saliendo del mismo prediction validado, no del motor Poisson anterior.
  const combinada = genericCombinada;
  const dq = dataQuality(prediction, odds, details);
  const storedOdds = config.key === 'baseball' ? baseballOddsShape(odds) : odds;

  await Promise.all([
    saveSportAnalysis(pgPool, config.key, game, {
      analysis: {
        provider: game.dataProvider, providerFixtureId: game.providerFixtureId,
        pitcherMatchup, playerMarkets: playerProbabilities,
        evidence: prediction.engine,
      },
      odds: storedOdds,
      probabilities,
      combinada,
      dataQuality: dq,
      cacheVersion: CACHE_VERSION,
    }),
    saveSportPrediction(pgPool, config.key, game, prediction),
  ]);
  return { game, prediction, probabilities, combinada, odds: storedOdds, dataQuality: dq };
}

async function mapLimited(items, concurrency, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { result[index] = { ok: true, value: await mapper(items[index], index) }; }
      catch (error) { result[index] = { ok: false, error }; }
    }
  });
  await Promise.all(runners);
  return result;
}

export async function analyzeSportDate(sport, date, options = {}) {
  const config = getMultisportConfig(sport);
  if (!isIsoDate(date)) throw new Error(`Fecha inválida: ${date}`);
  const allGames = await getSportGamesByDate(config.key, date, options);
  await Promise.all([persistSportSchedule(pgPool, config.key, date, allGames), persistSportGames(pgPool, config.key, allGames)]);
  const now = Date.now();
  const games = options.pregame
    ? allGames.filter((game) => {
      const kickoff = new Date(game.date).getTime();
      return !game.status?.isFinal && Number.isFinite(kickoff)
        && kickoff >= now - 60 * 60_000 && kickoff <= now + 3 * 60 * 60_000;
    })
    : allGames;
  const results = await mapLimited(games, options.concurrency || 2, (game) => analyzeSportGame(config.key, game, options));
  const failed = results.filter((row) => !row.ok);
  return {
    ok: failed.length === 0, sport: config.key, date, scheduled: allGames.length, total: games.length,
    analyzed: results.length - failed.length, failed: failed.length,
    errors: failed.slice(0, 5).map((row) => row.error?.message || String(row.error)),
  };
}

export async function prepareSportDate(sport, date, options = {}) {
  const config = getMultisportConfig(sport);
  if (!isIsoDate(date)) throw new Error(`Fecha inválida: ${date}`);
  const games = await getSportGamesByDate(config.key, date, options);
  await Promise.all([
    persistSportSchedule(pgPool, config.key, date, games),
    persistSportGames(pgPool, config.key, games),
  ]);
  return { ok: true, sport: config.key, date, total: games.length, games };
}

export async function finalizeSportDate(sport, date, options = {}) {
  const config = getMultisportConfig(sport);
  if (!isIsoDate(date)) throw new Error(`Fecha inválida: ${date}`);
  const games = await getSportGamesByDate(config.key, date, { ...options, ttl: 120 });
  await persistSportGames(pgPool, config.key, games);
  const finals = games.filter((game) => game.status?.isFinal && game.scores?.home?.total != null && game.scores?.away?.total != null);
  const table = `${config.tablePrefix}_engine_team_stats`;
  const existing = finals.length
    ? await pgPool.query(
      `SELECT fixture_id FROM ${table}
       WHERE fixture_id = ANY($1::text[])
       GROUP BY fixture_id
       HAVING bool_and(COALESCE((stats->>'_detailsAvailable')::boolean,FALSE))`,
      [finals.map((game) => String(game.id))],
    )
    : { rows: [] };
  const done = new Set(existing.rows.map((row) => String(row.fixture_id)));
  const pending = options.force ? finals : finals.filter((game) => !done.has(String(game.id)));
  const results = await mapLimited(pending, options.concurrency || 2, async (game) => {
    const details = await getSportGameDetails(config.key, game).catch((error) => {
      console.warn(`[${config.key}:details] ${game.id}: ${error.message}`);
      return null;
    });
    const ingested = await ingestFinalSportGame(pgPool, config.key, game, details);
    await pgPool.query(
      `UPDATE ${config.tablePrefix}_engine_predictions
       SET actual=$2::jsonb,finalized_at=COALESCE(finalized_at,now()),updated_at=now()
       WHERE fixture_id=$1`,
      [String(game.id), JSON.stringify({ home: game.scores.home.total, away: game.scores.away.total, periods: game.periods, stats: details?.teams || null })],
    );
    return ingested;
  });
  const failed = results.filter((row) => !row.ok);
  return { ok: failed.length === 0, sport: config.key, date, finals: finals.length, alreadyIngested: done.size, ingested: results.length - failed.length, failed: failed.length, errors: failed.map((row) => row.error?.message).slice(0, 5) };
}

function localDay(iso, timeZone) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC' }).format(new Date(iso)); }
  catch { return new Date(iso).toISOString().slice(0, 10); }
}

function storedGame(row, config) {
  const competition = getSportCompetition(config.key, row.competition_id);
  return {
    id: String(row.fixture_id), providerFixtureId: String(row.provider_fixture_id), dataProvider: row.provider,
    date: row.kickoff, season: row.season,
    league: {
      id: row.competition_id,
      name: competition?.name || config.competitionLabel,
      providerLeagueId: competition?.providerLeagueId || null,
    },
    country: { name: competition?.country || 'Estados Unidos' },
    status: {
      short: row.status || 'NS', long: row.status || 'Programado',
      isFinal: row.status === 'FT', isLive: row.status === 'LIVE',
    },
    teams: {
      home: { id: row.home_team_id, name: row.home_team, logo: row.home_logo },
      away: { id: row.away_team_id, name: row.away_team, logo: row.away_logo },
    },
    scores: { home: { total: row.home_score == null ? null : Number(row.home_score) }, away: { total: row.away_score == null ? null : Number(row.away_score) } },
    periods: row.periods || {}, raw: null,
  };
}

export async function listSportFixtures(sport, date, options = {}) {
  const config = getMultisportConfig(sport);
  if (!isIsoDate(date)) throw new Error(`Fecha inválida: ${date}`);
  const start = new Date(`${date}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(`${date}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 2);
  const matchesTable = `${config.tablePrefix}_engine_matches`;
  const availableCompetitions = getSportCompetitions(config.key);
  const configuredCompetitionIds = new Set(availableCompetitions.map((competition) => String(competition.id)));
  const requestedCompetitions = new Set((options.competitionKeys || []).map(String));
  const competitionAllowed = (game) => {
    if (!configuredCompetitionIds.has(String(game.league?.id || ''))) return false;
    if (!requestedCompetitions.size) return true;
    const competition = getSportCompetition(config.key, game.league?.id);
    return requestedCompetitions.has(String(game.league?.id))
      || (competition && requestedCompetitions.has(competition.key));
  };
  let stored = [];
  try {
    const { rows } = await pgPool.query(
      `SELECT * FROM ${matchesTable} WHERE kickoff >= $1 AND kickoff < $2 ORDER BY kickoff`, [start, end]);
    stored = rows.map((row) => storedGame(row, config))
      .filter((game) => localDay(game.date, options.timeZone || 'UTC') === date && competitionAllowed(game));
  } catch {}
  let games = stored;
  const configuredCompetitions = availableCompetitions
    .filter((competition) => !requestedCompetitions.size
      || requestedCompetitions.has(competition.key)
      || requestedCompetitions.has(String(competition.id)));
  const storedCompetitionIds = new Set(stored.map((game) => String(game.league?.id || '')));
  const missingCompetitionKeys = configuredCompetitions
    .filter((competition) => !storedCompetitionIds.has(String(competition.id)))
    .map((competition) => competition.key);

  if (!games.length || missingCompetitionKeys.length) {
    // La fecha solicitada representa el calendario del usuario, no el del
    // proveedor. Consultar días adyacentes evita perder partidos nocturnos al
    // cruzar Bogotá/Nueva York con Europa o Asia; las respuestas quedan
    // cacheadas y esta ruta solo llega al proveedor cuando aún no hay DB.
    const providerDates = [-1, 0, 1].map((offset) => {
      const value = new Date(`${date}T12:00:00Z`);
      value.setUTCDate(value.getUTCDate() + offset);
      return value.toISOString().slice(0, 10);
    });
    const providerOptions = {
      ...options,
      competitionKeys: missingCompetitionKeys.length
        ? missingCompetitionKeys
        : configuredCompetitions.map((competition) => competition.key),
    };
    const attempts = await Promise.allSettled(providerDates.map((providerDate) => (
      getSportGamesByDate(config.key, providerDate, providerOptions)
    )));
    const fetched = attempts.filter((attempt) => attempt.status === 'fulfilled').map((attempt) => attempt.value);
    if (!fetched.length && !stored.length) {
      throw attempts.find((attempt) => attempt.status === 'rejected')?.reason || new Error('Calendario no disponible');
    }
    const fetchedForDay = fetched.flat()
      .filter((game) => localDay(game.date, options.timeZone || 'UTC') === date && competitionAllowed(game));
    games = [...new Map([...stored, ...fetchedForDay]
      .map((game) => [String(game.id), game])).values()]
      .sort((left, right) => new Date(left.date) - new Date(right.date));

    // Guardar el calendario ampliado evita repetir trabajo y permite que los
    // procesos de análisis/finalización encuentren exactamente los mismos IDs.
    if (fetchedForDay.length) {
      await persistSportGames(pgPool, config.key, fetchedForDay).catch((error) => {
        console.warn(`[${config.key}:schedule-cache] ${error.message}`);
      });
    }
  }
  const analyses = await getSportAnalyses(pgPool, config.key, games.map((game) => game.id)).catch(() => []);
  const map = new Map(analyses.map((analysis) => [String(analysis.fixture_id), analysis]));
  return games.map((game) => {
    const publicGame = { ...game };
    delete publicGame.raw;
    delete publicGame.espnOdds;
    delete publicGame.espnProviderFixtureId;
    return {
      ...publicGame,
      analysis: map.get(String(game.id)) || null,
      isAnalyzed: map.has(String(game.id)),
    };
  });
}

export { CACHE_VERSION as MULTISPORT_CACHE_VERSION };
