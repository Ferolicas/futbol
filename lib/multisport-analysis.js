import { pgPool } from './db.js';
import { getMultisportConfig, getSportCompetition, getSportCompetitions, isIsoDate } from './multisport-config.js';
import { getSportGameDetails, getSportGamesByDate, getSportOdds } from './multisport-providers.js';
import {
  buildEmpiricalPlayerProbabilities,
  computeMultisportEmpiricalPrediction,
  toBaseballProbabilityShape,
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

const CACHE_VERSION = 13; // catálogo Bet365 exacto y toda recomendación exige cuota >= 1.20

function shiftIsoDate(date, amount) {
  if (!isIsoDate(date)) throw new Error(`Fecha inválida: ${date}`);
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

// Una fecha local puede reunir juegos de dos jornadas del proveedor. El
// reconciliador cubre también los días adyacentes para que cambiar de zona
// horaria nunca convierta una tarjeta válida en una acción manual de análisis.
export function buildSportAnalysisCoverageDates(date) {
  return [-1, 0, 1].map((offset) => shiftIsoDate(date, offset));
}

export function selectGamesNeedingCurrentAnalysis(games, analyses, cacheVersion = CACHE_VERSION) {
  const current = new Set((analyses || [])
    .filter((analysis) => Number(analysis?.cache_version || 0) >= cacheVersion)
    .map((analysis) => String(analysis.fixture_id)));
  return (games || []).filter((game) => !current.has(String(game.id)));
}

function lineKey(value) {
  return String(value).replace('-', 'm').replace('.', '_');
}

function oddValue(entry) {
  if (entry == null) return null;
  const value = Number(typeof entry === 'object' ? entry.odd : entry);
  return Number.isFinite(value) && value >= 1.2 ? value : null;
}

function normalizedBookmaker(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function oddMetadata(entry) {
  if (!entry || typeof entry !== 'object') return {};
  return {
    bookmaker: entry.bookmaker || null,
    bookmakerId: entry.bookmakerId ?? null,
    bookmakerMarketId: entry.marketId ?? null,
    bookmakerMarket: entry.marketName || null,
    bookmakerSelection: entry.selectionName || null,
  };
}

function signedLine(value) {
  const line = Number(value);
  return Number.isFinite(line) && line > 0 ? `+${line}` : String(value);
}

function probabilityValue(entry) {
  const value = Number(entry?.probability ?? entry);
  return Number.isFinite(value) ? value : null;
}

function rawProbabilityValue(entry) {
  const raw = entry?.rawProbability == null ? null : Number(entry.rawProbability);
  if (raw != null && Number.isFinite(raw)) return raw * 100;
  return probabilityValue(entry);
}

export function buildMultisportCombinada(prediction, odds, game, options = {}) {
  const config = getMultisportConfig(prediction.sport);
  const isBaseball = config.key === 'baseball';
  const candidates = [];
  const add = ({ id, category, marketLabel, name, probability, odd, validationKey, scope = 'match', line = null, side = null }) => {
    const p = probabilityValue(probability);
    const rawProbability = rawProbabilityValue(probability);
    const o = oddValue(odd);
    if (p == null || rawProbability == null || !o || rawProbability < (options.selectableThreshold || 80)) return;
    const metadata = oddMetadata(odd);
    // Defensa adicional al filtro del proveedor: una fila antigua, un payload
    // manual o una configuración global nunca puede colar otra casa en Baseball.
    if (isBaseball && normalizedBookmaker(metadata.bookmaker) !== 'bet365') return;
    candidates.push({
      id,
      category,
      market: marketLabel || category,
      marketLabel: marketLabel || category,
      name,
      pick: name,
      probability: p,
      rawProbability,
      odd: o,
      validationKey,
      scope,
      line,
      side,
      ...metadata,
      statisticalRecommendation: true,
    });
  };

  add({ id: 'ml-home', category: 'moneyline', marketLabel: 'Ganador del partido', name: `${game.teams.home.name} gana`, probability: prediction.moneyline?.home, odd: odds?.moneyline?.home, validationKey: 'moneyline_home', side: 'home' });
  add({ id: 'ml-away', category: 'moneyline', marketLabel: 'Ganador del partido', name: `${game.teams.away.name} gana`, probability: prediction.moneyline?.away, odd: odds?.moneyline?.away, validationKey: 'moneyline_away', side: 'away' });
  if (config.drawAllowed) add({ id: 'ml-draw', category: 'moneyline', marketLabel: 'Ganador del partido', name: 'Empate', probability: prediction.moneyline?.draw, odd: odds?.moneyline?.draw, validationKey: 'moneyline_draw', side: 'draw' });

  for (const [line, values] of Object.entries(prediction.totals?.lines || {})) {
    add({ id: `total-${line}-over`, category: `total-${line}`, marketLabel: `Total de ${config.scoreLabel}`, name: `Más de ${line} ${config.scoreLabel}`, probability: values.over, odd: odds?.totals?.[line]?.over, validationKey: `total_over_${lineKey(line)}`, line: Number(line), side: 'over' });
    add({ id: `total-${line}-under`, category: `total-${line}`, marketLabel: `Total de ${config.scoreLabel}`, name: `Menos de ${line} ${config.scoreLabel}`, probability: values.under, odd: odds?.totals?.[line]?.under, validationKey: `total_under_${lineKey(line)}`, line: Number(line), side: 'under' });
  }

  if (isBaseball) {
    const spread = prediction.spread || {};
    add({ id: 'handicap-home-minus-1.5', category: 'handicap-home-minus-1.5', marketLabel: 'Hándicap asiático', name: `${game.teams.home.name} -1.5`, probability: spread.homeMinus, odd: odds?.spreads?.home?.[-1.5], validationKey: 'spread_home_minus_1_5', line: -1.5, side: 'home' });
    add({ id: 'handicap-away-plus-1.5', category: 'handicap-home-minus-1.5', marketLabel: 'Hándicap asiático', name: `${game.teams.away.name} +1.5`, probability: spread.awayPlus, odd: odds?.spreads?.away?.[1.5], validationKey: 'spread_away_plus_1_5', line: 1.5, side: 'away' });
    add({ id: 'handicap-away-minus-1.5', category: 'handicap-away-minus-1.5', marketLabel: 'Hándicap asiático', name: `${game.teams.away.name} -1.5`, probability: spread.awayMinus, odd: odds?.spreads?.away?.[-1.5], validationKey: 'spread_away_minus_1_5', line: -1.5, side: 'away' });
    add({ id: 'handicap-home-plus-1.5', category: 'handicap-away-minus-1.5', marketLabel: 'Hándicap asiático', name: `${game.teams.home.name} +1.5`, probability: spread.homePlus, odd: odds?.spreads?.home?.[1.5], validationKey: 'spread_home_plus_1_5', line: 1.5, side: 'home' });

    for (const [line, values] of Object.entries(prediction.period?.totals || {})) {
      add({ id: `first5-total-${line}-over`, category: `first5-total-${line}`, marketLabel: 'Total de carreras (primeras 5 entradas)', name: `Más de ${line} carreras en las primeras 5 entradas`, probability: values.over, odd: odds?.periods?.first5?.totals?.[line]?.over, validationKey: `first5_total_over_${lineKey(line)}`, line: Number(line), side: 'over' });
      add({ id: `first5-total-${line}-under`, category: `first5-total-${line}`, marketLabel: 'Total de carreras (primeras 5 entradas)', name: `Menos de ${line} carreras en las primeras 5 entradas`, probability: values.under, odd: odds?.periods?.first5?.totals?.[line]?.under, validationKey: `first5_total_under_${lineKey(line)}`, line: Number(line), side: 'under' });
    }

    add({ id: 'first5-handicap-home-0', category: 'first5-handicap-0', marketLabel: 'Hándicap asiático (primeras 5 entradas)', name: `${game.teams.home.name} ${signedLine(0)} en las primeras 5 entradas`, probability: prediction.period?.moneyline?.home, odd: odds?.periods?.first5?.spreads?.home?.[0], validationKey: 'first5_handicap_home_0', line: 0, side: 'home' });
    add({ id: 'first5-handicap-away-0', category: 'first5-handicap-0', marketLabel: 'Hándicap asiático (primeras 5 entradas)', name: `${game.teams.away.name} ${signedLine(0)} en las primeras 5 entradas`, probability: prediction.period?.moneyline?.away, odd: odds?.periods?.first5?.spreads?.away?.[0], validationKey: 'first5_handicap_away_0', line: 0, side: 'away' });

    for (const team of ['home', 'away']) {
      const teamName = game.teams[team].name;
      for (const [line, values] of Object.entries(prediction.teamTotals?.[team] || {})) {
        add({ id: `team-total-${team}-${line}-over`, category: `team-total-${team}-${line}`, marketLabel: `Total de carreras de ${teamName}`, name: `${teamName}: más de ${line} carreras`, probability: values.over, odd: odds?.teamTotals?.[team]?.[line]?.over, validationKey: `team_total_${team}_over_${lineKey(line)}`, scope: 'team', line: Number(line), side: 'over' });
        add({ id: `team-total-${team}-${line}-under`, category: `team-total-${team}-${line}`, marketLabel: `Total de carreras de ${teamName}`, name: `${teamName}: menos de ${line} carreras`, probability: values.under, odd: odds?.teamTotals?.[team]?.[line]?.under, validationKey: `team_total_${team}_under_${lineKey(line)}`, scope: 'team', line: Number(line), side: 'under' });
      }
    }
  }

  // Un resultado por categoría evita recomendar simultáneamente dos líneas
  // correlacionadas del mismo mercado.
  const bestByCategory = new Map();
  for (const item of candidates) {
    const previous = bestByCategory.get(item.category);
    if (!previous || item.rawProbability > previous.rawProbability) bestByCategory.set(item.category, item);
  }
  const selectable = [...bestByCategory.values()].sort((a, b) => b.rawProbability - a.rawProbability || b.odd - a.odd);
  const selections = selectable.filter((item) => item.rawProbability >= (options.highlightThreshold || 90)).slice(0, 3);
  const combinedOdd = selections.length ? selections.reduce((value, item) => value * item.odd, 1) : null;
  const combinedProbability = selections.length ? selections.reduce((value, item) => value * (item.rawProbability / 100), 1) * 100 : 0;
  return {
    selections,
    selectable,
    combinedOdd: combinedOdd == null ? null : Math.round(combinedOdd * 100) / 100,
    combinedProbability: Math.round((combinedProbability + Number.EPSILON) * 100) / 100,
    hasRealOdds: selectable.length > 0,
    source: 'empirical-exact',
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
      home_minus_1_5: oddValue(odds?.spreads?.home?.[-line]),
      home_plus_1_5: oddValue(odds?.spreads?.home?.[line]),
      away_minus_1_5: oddValue(odds?.spreads?.away?.[-line]),
      away_plus_1_5: oddValue(odds?.spreads?.away?.[line]),
    },
  };
}

function dataQuality(prediction, odds, details) {
  const homeSamples = Number(prediction.engine?.samples?.homeTeam || 0);
  const awaySamples = Number(prediction.engine?.samples?.awayTeam || 0);
  const hasOdds = Object.keys(odds?.moneyline || {}).length > 0
    || Object.keys(odds?.totals || {}).length > 0
    || Object.keys(odds?.spreads || {}).length > 0
    || Object.keys(odds?.periods || {}).length > 0
    || Object.keys(odds?.teamTotals?.home || {}).length > 0
    || Object.keys(odds?.teamTotals?.away || {}).length > 0;
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
  let odds = {
    moneyline: {}, totals: {}, spreads: {}, periods: {}, teamTotals: { home: {}, away: {} },
    catalog: [], rawBookmakers: [], source: `api-${config.oddsProvider}`,
  };
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
  // saliendo del mismo prediction empírico, no del motor Poisson anterior.
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
  const eligibleGames = options.pregame
    ? allGames.filter((game) => {
      const kickoff = new Date(game.date).getTime();
      return !game.status?.isFinal && Number.isFinite(kickoff)
        && kickoff >= now - 60 * 60_000 && kickoff <= now + 3 * 60 * 60_000;
    })
    : allGames;
  let games = eligibleGames;
  let alreadyCurrent = 0;
  if (options.onlyMissingCurrent === true && eligibleGames.length) {
    const existing = await getSportAnalyses(pgPool, config.key, eligibleGames.map((game) => game.id));
    games = selectGamesNeedingCurrentAnalysis(eligibleGames, existing);
    alreadyCurrent = eligibleGames.length - games.length;
  }
  const results = await mapLimited(games, options.concurrency || 2, (game) => analyzeSportGame(config.key, game, options));
  const failed = results.filter((row) => !row.ok);
  return {
    ok: failed.length === 0, sport: config.key, date, scheduled: allGames.length, total: games.length,
    analyzed: results.length - failed.length, alreadyCurrent, failed: failed.length,
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

  if (options.allowProviderFetch !== false && (!games.length || missingCompetitionKeys.length)) {
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
  const currentAnalyses = analyses.filter((analysis) => Number(analysis.cache_version || 0) >= CACHE_VERSION);
  const map = new Map(currentAnalyses.map((analysis) => [String(analysis.fixture_id), analysis]));
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
