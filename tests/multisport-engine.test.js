const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MULTISPORT_CURRENT_SEASON_SHARE,
  normalizeMultisportEngineConfig,
  invertEmpiricalEvidence,
  computeMultisportEmpiricalPrediction,
  computeMultisportEmpiricalPlayerMarkets,
  buildEmpiricalPlayerProbabilities,
  toBaseballProbabilityShape,
  multisportEngineInternals,
} = require('../lib/multisport-empirical-engine.js');
const { apiSportsInternals, normalizeApiSportsOdds } = require('../lib/api-sports-multisport.js');
const { normalizeTeamStatistics, multisportStoreInternals } = require('../lib/multisport-store.js');
const { normalizeApiBasketballGame, normalizeApiNbaGame, nbaStatsInternals } = require('../lib/nba-stats-api.js');
const { normalizeMlbGame, normalizeNflGame } = require('../lib/multisport-providers.js');
const { normalizeEspnGame, normalizeEspnOdds } = require('../lib/espn-sports-api.js');
const { getSportCompetitions, isIsoDate } = require('../lib/multisport-config.js');
const { isMlbHitPlay } = require('../lib/mlb-stats-api.js');

test('el motor multi-deporte conserva 100% crudo y muestra máximo 95%', () => {
  const rate = multisportEngineInternals.empiricalRate(
    [{ _value: 3, _current: true, _weight: 1 }],
    (value) => value > 1.5 ? 1 : 0,
    0.72,
  );
  assert.equal(rate.n, 1);
  assert.equal(rate.hits, 1);
  assert.equal(rate.p, 1);
  assert.equal(multisportEngineInternals.displayPercent(rate.p), 95);
  assert.equal(multisportEngineInternals.displayPercent(0.9999), 95);
  assert.equal(multisportEngineInternals.displayPercent(0.9), 90);
  assert.equal(multisportEngineInternals.displayPercent(0.5), 50);
});

test('la actualidad domina al histórico sin borrar ninguna observación', () => {
  const rate = multisportEngineInternals.empiricalRate([
    { _value: 1, _current: true, _weight: 1 },
    { _value: 0, _current: false, _weight: 1 },
  ], (value) => value, MULTISPORT_CURRENT_SEASON_SHARE);
  assert.equal(rate.n, 2);
  assert.equal(rate.current.n, 1);
  assert.equal(rate.historical.n, 1);
  assert.equal(rate.p, 0.65);
});

test('el entrenamiento no puede alterar el contrato fijo 65/35', () => {
  assert.equal(normalizeMultisportEngineConfig({ currentShare: 0.9 }).currentShare, 0.65);
  assert.equal(normalizeMultisportEngineConfig({ currentShare: 0.51 }).currentShare, 0.65);
});

test('cada participante pesa 50/50 aunque tenga una muestra distinta', () => {
  const rate = multisportEngineInternals.participantWeightedEmpiricalRate([
    ...Array.from({ length: 10 }, (_, index) => ({ _side: 'home', _value: index < 9 ? 1 : 0, _current: true, _weight: 1 })),
    ...Array.from({ length: 2 }, () => ({ _side: 'away', _value: 0, _current: true, _weight: 1 })),
  ], (value) => value, MULTISPORT_CURRENT_SEASON_SHARE);
  assert.equal(rate.p, 0.45);
  assert.equal(rate.teams.length, 2);
});

test('la evidencia del under invierte aciertos por equipo y temporada', () => {
  const inverted = invertEmpiricalEvidence({
    n: 12, hits: 9, rawProbability: 0.75,
    current: { n: 2, hits: 2, p: 1 },
    historical: { n: 10, hits: 7, p: 0.7 },
    teams: [{
      participant: 'home', n: 12, hits: 9, p: 0.75,
      current: { n: 2, hits: 2, p: 1 },
      historical: { n: 10, hits: 7, p: 0.7 },
    }],
  });
  assert.equal(inverted.hits, 3);
  assert.equal(inverted.current.hits, 0);
  assert.equal(inverted.historical.hits, 3);
  assert.equal(inverted.teams[0].hits, 3);
  assert.equal(inverted.teams[0].current.hits, 0);
  assert.equal(inverted.teams[0].historical.hits, 3);
});

test('un H2H duplicado por las dos perspectivas cuenta una sola vez', () => {
  const rows = multisportEngineInternals.dedupeObservations([
    [{ fixture_id: '10', _value: 9, _weight: 1 }],
    [{ fixture_id: '10', _value: 9, _weight: 1.2 }],
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]._weight, 1.2);
});

test('baseball, NBA y NFL comparten fórmula pero consultan tabla aislada', async () => {
  const base = { kickoff: new Date('2026-01-01T12:00:00Z'), season: '2026', competition_id: '1', period_scores: [1, 0, 0, 0, 0], period_scores_against: [0, 0, 0, 0, 0], stats: {} };
  const byTeam = {
    '1': [
      { ...base, fixture_id: 'a', team_id: '1', opponent_id: '8', is_home: true, score_for: 3, score_against: 1 },
      { ...base, fixture_id: 'b', team_id: '1', opponent_id: '9', is_home: false, score_for: 1, score_against: 2 },
    ],
    '2': [
      { ...base, fixture_id: 'c', team_id: '2', opponent_id: '7', is_home: false, score_for: 0, score_against: 4 },
      { ...base, fixture_id: 'd', team_id: '2', opponent_id: '6', is_home: true, score_for: 2, score_against: 1 },
    ],
  };
  const sqlSeen = [];
  const pool = { async query(sql, params) { sqlSeen.push(sql); return { rows: byTeam[String(params[0])] || [] }; } };
  const fixture = {
    id: 'future', date: '2026-02-01T12:00:00Z', season: '2026', league: { id: '1' },
    teams: { home: { id: '1', name: 'A' }, away: { id: '2', name: 'B' } }, context: { home: {}, away: {} },
  };
  const prediction = await computeMultisportEmpiricalPrediction(pool, {
    sport: 'baseball', fixture,
    config: { currentShare: .72, venueBoost: 1, opponentBoost: 1, competitionBoost: 1, starterBoost: 1, lineupBoost: 1 },
  });
  assert.equal(prediction.moneyline.home.probability, 50);
  assert.equal(prediction.moneyline.home.evidence.n, 4);
  assert.ok(sqlSeen.every((sql) => sql.includes('baseball_engine_team_stats')));
});

test('baseball calcula las nueve entradas, tramos e hits sin depender de cuotas', async () => {
  const row = {
    kickoff: '2026-01-01T12:00:00Z', season: '2026', competition_id: '1',
    is_home: true, score_for: 4, score_against: 2,
    period_scores: [1, 0, 1, 0, 0, 1, 0, 1, 0],
    period_scores_against: [0, 1, 0, 0, 0, 0, 1, 0, 0],
    stats: {
      hits: 9, opponentHits: 7,
      hitsByInning: [2, 0, 1, 1, 0, 2, 1, 1, 1],
      opponentHitsByInning: [0, 1, 1, 0, 1, 1, 1, 1, 1],
    },
  };
  const fixture = {
    id: 'future', date: '2026-02-01T12:00:00Z', season: '2026', league: { id: '1' },
    teams: { home: { id: '1', name: 'A' }, away: { id: '2', name: 'B' } }, context: { home: {}, away: {} },
  };
  const prediction = await computeMultisportEmpiricalPrediction({ query: async () => ({ rows: [] }) }, {
    sport: 'baseball', fixture,
    teamRows: {
      home: [{ ...row, fixture_id: 'a', team_id: '1', opponent_id: '8' }],
      away: [{ ...row, fixture_id: 'b', team_id: '2', opponent_id: '9', is_home: false }],
    },
    odds: {
      periods: { first3: { label: 'primeras 3 entradas', totals: { 2.5: {} }, spreads: { home: {}, away: {} } } },
      statistics: { hits: { home: { 8.5: {} }, away: {}, total: { 15.5: {} } } },
      spreads: { home: { '-2.5': {} }, away: {} },
    },
    config: { currentShare: .72, venueBoost: 1, opponentBoost: 1, competitionBoost: 1, starterBoost: 1, lineupBoost: 1 },
  });
  assert.equal(Object.keys(prediction.innings).length, 9);
  assert.equal(prediction.innings[1].run.yes.rawProbability, 1);
  assert.equal(prediction.periods.first3.totals[2.5].over.rawProbability, 1);
  assert.equal(prediction.periods.first3.statistics.hits.home[1.5].over.rawProbability, 1);
  assert.equal(prediction.periods.first3.statistics.hits.total[5.5].over.rawProbability, 0);
  assert.equal(prediction.statistics.hits.home[8.5].over.rawProbability, .5);
  assert.ok(prediction.statistics.hits.total[15.5]);
  assert.ok(prediction.spreads.home[-2.5]);

  const visual = toBaseballProbabilityShape(prediction);
  assert.equal(visual.innings[1].run.yes, 95);
  assert.equal(visual.periods.first3.totals[2.5].over, 95);
  assert.equal(visual.periods.first3.statistics.hits.home[1.5].over, 95);
  assert.equal(visual.statistics.hits.home[8.5].over, 50);
});

test('props de jugador son frecuencias directas y conservan evidencia', () => {
  const result = buildEmpiricalPlayerProbabilities({ hits: [{ id: 7, name: 'Bateador', history: [1, 0] }] });
  assert.equal(result.hits[0].lineProbs[0.5], 50);
  assert.deepEqual(result.hits[0].evidence[0.5], { n: 2, hits: 1, rawProbability: 0.5 });
});

test('el motor de jugadores consulta su tabla deportiva y acepta una muestra', async () => {
  const pool = { async query(sql) {
    assert.match(sql, /basketball_engine_player_stats/);
    return { rows: [{ fixture_id: 'old', kickoff: '2025-12-01T00:00:00Z', player_id: '7', player_name: 'Base', team_id: '1', opponent_id: '9', competition_id: 'NBA', season: '2025-2026', is_starter: true, stats: { points: 21 } }] };
  } };
  const result = await computeMultisportEmpiricalPlayerMarkets(pool, {
    sport: 'basketball',
    fixture: { date: '2026-01-01T00:00:00Z', season: '2025-2026', league: { id: 'NBA' }, teams: { home: { id: '1' }, away: { id: '2' } } },
    players: [{ id: '7', name: 'Base', teamId: '1', starter: true }],
    lines: { points: [20.5] },
    config: { currentShare: .72, venueBoost: 1, opponentBoost: 1, competitionBoost: 1, starterBoost: 1, lineupBoost: 1 },
  });
  assert.equal(result.points[0].lineProbs[20.5], 95);
  assert.equal(result.points[0].evidence[20.5].n, 1);
  assert.equal(result.points[0].evidence[20.5].rawProbability, 1);
});

test('las cuotas API-Sports se normalizan sin entrar en la probabilidad', () => {
  const odds = normalizeApiSportsOdds([{ bookmakers: [{ name: 'Bet365', bets: [
    { name: 'Home/Away', values: [{ value: 'Home', odd: '1.80' }, { value: 'Away', odd: '2.10' }] },
    { name: 'Total', values: [{ value: 'Over 8.5', odd: '1.91' }, { value: 'Under 8.5', odd: '1.95' }] },
  ] }] }], { teams: { home: { name: 'Local' }, away: { name: 'Visitante' } } });
  assert.equal(odds.moneyline.home.odd, 1.8);
  assert.equal(odds.totals[8.5].under.odd, 1.95);
});

test('normaliza hándicap, total de equipo y mercados por mitad exactos de Bet365', () => {
  const odds = normalizeApiSportsOdds([{ bookmakers: [{ name: 'Bet365', bets: [
    { name: 'Asian Handicap', values: [{ value: 'Home -3.5', odd: '1.90' }, { value: 'Away +3.5', odd: '1.90' }] },
    { name: 'Home Team Total', values: [{ value: 'Over 21.5', odd: '1.84' }, { value: 'Under 21.5', odd: '1.96' }] },
    { name: '1st Half Total', values: [{ value: 'Over 20.5', odd: '1.91' }, { value: 'Under 20.5', odd: '1.89' }] },
    { name: '1st Half Winner', values: [{ value: 'Home', odd: '1.80' }, { value: 'Away', odd: '2.10' }] },
  ] }] }], { teams: { home: { name: 'Local' }, away: { name: 'Visitante' } } }, {
    sport: 'american_football', bookmakers: ['Bet365'],
  });
  assert.equal(odds.spreads.home[-3.5].odd, 1.9);
  assert.equal(odds.teamTotals.home[21.5].over.odd, 1.84);
  assert.equal(odds.periods.firstHalf.totals[20.5].under.odd, 1.89);
  assert.equal(odds.periods.firstHalf.moneyline.home.odd, 1.8);
  assert.ok(odds.catalog.every(selection => selection.bookmaker === 'Bet365'));
});

test('API-Sports distingue el límite por minuto de la cuota diaria', () => {
  assert.equal(apiSportsInternals.classifyProviderLimit(200, [
    'rateLimit: Too many requests. Your rate limit is 10 requests per minute.',
  ]), 'minute');
  assert.equal(apiSportsInternals.classifyProviderLimit(200, [
    'You have reached the request limit for the day',
  ]), 'daily');
  assert.equal(apiSportsInternals.classifyProviderLimit(200, [
    'Free plans do not have access to this season',
  ]), null);
});

test('normaliza boxscores de proveedores a métricas canónicas', () => {
  const stats = normalizeTeamStatistics([
    { type: 'Total Rebounds', value: '44' },
    { type: 'Assists', value: 27 },
    { type: 'Turnovers', value: 11 },
  ]);
  assert.deepEqual(stats, { rebounds: 44, assists: 27, turnovers: 11 });
  assert.deepEqual(normalizeTeamStatistics({ yards: { total: 321 }, passing: { total: 240 }, rushings: { total: 81 }, turnovers: { total: 2 } }), {
    turnovers: 2, totalYards: 321, passingYards: 240, rushingYards: 81,
  });
  assert.equal(normalizeTeamStatistics({ penalties: { total: '7-55' } }).penalties, 7);
  assert.deepEqual(normalizeTeamStatistics([
    { name: 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', value: '11-29' },
    { name: 'fouls', value: '23' },
    { name: 'netPassingYards', value: '240' },
    { name: 'totalPenaltiesYards', value: '6-40' },
  ]), { personalFouls: 23, threePointersMade: 11, passingYards: 240, penalties: 6 });
});

test('API-NBA y API-Basketball conservan el mismo ID canónico', () => {
  const nba = normalizeApiNbaGame({
    id: 10, date: { start: '2026-01-16T00:30:00Z' }, status: { short: 1, long: 'Scheduled' },
    teams: { home: { id: 9, name: 'Denver Nuggets', code: 'DEN' }, visitors: { id: 2, name: 'Boston Celtics', code: 'BOS' } },
    scores: { home: { points: null, linescore: [] }, visitors: { points: null, linescore: [] } },
  }, '2026-01-15');
  const generic = normalizeApiBasketballGame({
    id: 20, date: '2026-01-16T00:30:00Z', status: { short: 'NS', long: 'Not Started' },
    league: { id: 12, name: 'NBA' }, teams: { home: { id: 100, name: 'Denver Nuggets' }, away: { id: 200, name: 'Boston Celtics' } },
    scores: { home: {}, away: {} },
  }, '2026-01-15');
  assert.equal(nba.id, generic.id);
  assert.equal(nba.season, '2025-2026');
  assert.equal(nba.scores.home.total, null);
});

test('API-NBA se cruza con el ID y la foto oficial del jugador', () => {
  const players = nbaStatsInternals.normalizeProviderPlayers([{
    player: { id: 3448, firstname: 'Chet', lastname: 'Holmgren' },
    team: { name: 'Oklahoma City Thunder' },
    points: 24,
  }], [{
    id: '1631096', name: 'Chet Holmgren', normalizedName: 'chetholmgren',
    teamId: '1610612760', teamCode: 'OKC', position: 'C-F', active: true,
  }]);
  assert.equal(players[0].id, '1631096');
  assert.equal(players[0].providerPlayerId, '3448');
  assert.equal(players[0].position, 'C-F');
  assert.equal(players[0].photo, 'https://cdn.nba.com/headshots/nba/latest/1040x760/1631096.png');
  assert.equal(nbaStatsInternals.cleanPlayerName('Gary Trent Jr.'), 'garytrent');
});

test('normaliza el contrato anidado real de API-NFL', () => {
  const game = normalizeNflGame({
    game: { id: 13146, date: { timestamp: 1722556800 }, status: { short: 'FT', long: 'Finished' } },
    league: { id: 1, name: 'NFL', season: '2024', country: { name: 'USA' } },
    teams: { home: { id: 16, name: 'Chicago Bears' }, away: { id: 26, name: 'Houston Texans' } },
    scores: { home: { quarter_1: 0, quarter_2: 14, quarter_3: 7, quarter_4: null, overtime: null, total: 21 }, away: { quarter_1: 7, quarter_2: 10, quarter_3: 0, quarter_4: null, overtime: null, total: 17 } },
  }, '2024-08-02');
  assert.equal(game.id, 'NFL-2024-08-02-houston-texans-chicago-bears');
  assert.equal(game.providerFixtureId, '13146');
  assert.equal(game.status.isFinal, true);
  assert.equal(game.scores.home.total, 21);
  assert.deepEqual(game.periods.home, [0, 14, 7, null, null]);
});

test('ESPN conserva IDs canónicos y separa NCAA de las grandes ligas', () => {
  const event = {
    id: '401999999', date: '2026-11-04T00:00:00Z', season: { year: 2026 },
    status: { type: { state: 'pre', completed: false } },
    competitions: [{ competitors: [
      { homeAway: 'home', team: { id: '10', displayName: 'Equipo Universitario A', abbreviation: 'EUA', logo: 'https://example.com/a.png' } },
      { homeAway: 'away', team: { id: '20', displayName: 'Equipo Universitario B', abbreviation: 'EUB', logo: 'https://example.com/b.png' } },
    ] }],
  };
  const game = normalizeEspnGame(event, 'ncaa', '2026-11-04');
  assert.equal(game.id, 'NCAAB:401999999');
  assert.equal(game.league.id, '116');
  assert.equal(game.teams.home.id, 'NCAAB:10');
  assert.equal(game.season, '2026-2027');
  assert.equal(game.scores.home.total, null);
  assert.deepEqual(getSportCompetitions('american_football').map((competition) => competition.key), ['nfl', 'ncaa-fbs', 'ncaa-fcs']);
});

test('las cuotas universitarias incluidas se convierten a decimal sin alterar porcentajes', () => {
  const odds = normalizeEspnOdds({ competitions: [{ odds: [{
    provider: { id: '100', displayName: 'Sportsbook' }, overUnder: 48.5,
    moneyline: { home: { close: { odds: '-200' } }, away: { close: { odds: '+175' } } },
    pointSpread: { home: { close: { line: '-4.5', odds: '-110' } }, away: { close: { line: '+4.5', odds: '-110' } } },
    total: { over: { close: { odds: '-105' } }, under: { close: { odds: '-115' } } },
  }] }] });
  assert.equal(odds.moneyline.home.odd, 1.5);
  assert.equal(odds.moneyline.away.odd, 2.75);
  assert.equal(odds.totals[48.5].over.odd, 1.952);
  assert.equal(odds.spreads.home[-4.5].odd, 1.909);
});

test('MLB conserva entradas, hits y errores oficiales en los hechos históricos', () => {
  const game = normalizeMlbGame({
    gamePk: 9, dateUTC: '2026-07-01T23:00:00Z', status: 'Final', isFinal: true, isLive: false,
    home: { id: 1, name: 'Home', score: 4, hits: 8, errors: 1 },
    away: { id: 2, name: 'Away', score: 2, hits: 6, errors: 0 },
    innings: [{ number: 1, home: 1, away: 0 }, { number: 2, home: 3, away: 2 }],
  });
  const fact = multisportStoreInternals.factsForGame(game, null, 'home');
  assert.deepEqual(game.periods.home, [1, 3]);
  assert.equal(fact.stats.hits, 8);
  assert.equal(fact.stats.errors, 1);
  assert.equal(fact.stats.opponentHits, 6);
  assert.equal(fact.stats._detailsAvailable, false);
});

test('MLB cuenta hits por eventType oficial y no por el tipo genérico atBat', () => {
  for (const eventType of ['single', 'double', 'triple', 'home_run']) {
    assert.equal(isMlbHitPlay({ result: { type: 'atBat', eventType } }), true);
  }
  for (const eventType of ['field_out', 'field_error', 'walk', 'strikeout']) {
    assert.equal(isMlbHitPlay({ result: { type: 'atBat', eventType } }), false);
  }
});

test('rechaza fechas imposibles antes de consultar un proveedor', () => {
  assert.equal(isIsoDate('2026-08-01'), true);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('01-08-2026'), false);
});
