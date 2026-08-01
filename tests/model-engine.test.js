const test = require('node:test');
const assert = require('node:assert/strict');

const {
  empiricalRate,
  computeBaseMarkets,
  DEFAULT_ENGINE_CONFIG,
  normalizeEngineConfig,
  lineupRowsFromApi,
  annotateLineupSimilarity,
} = require('../lib/model-engine.js');

test('el entrenamiento nunca puede hacer que el histórico pese más', () => {
  assert.equal(normalizeEngineConfig({ currentShare: 0 }).currentShare, 0.55);
  assert.equal(normalizeEngineConfig({ currentShare: 0.5 }).currentShare, 0.55);
  assert.equal(normalizeEngineConfig({ currentShare: 0.72 }).currentShare, 0.72);
  assert.equal(normalizeEngineConfig({ currentShare: 1 }).currentShare, 0.95);
});

test('usa cualquier cantidad de partidos sin mínimo de muestra', () => {
  const one = empiricalRate([{ hit: 1, _current: true, _weight: 1 }], (row) => row.hit, 0.72);
  assert.equal(one.n, 1);
  assert.equal(one.p, 1);

  const two = empiricalRate([
    { hit: 1, _current: true, _weight: 1 },
    { hit: 0, _current: true, _weight: 1 },
  ], (row) => row.hit, 0.72);
  assert.equal(two.n, 2);
  assert.equal(two.hits, 1);
  assert.equal(two.p, 0.5);
});

test('la actualidad domina al histórico sin borrar ninguno de los dos', () => {
  const result = empiricalRate([
    { hit: 1, _current: true, _weight: 1 },
    { hit: 0, _current: false, _weight: 1 },
  ], (row) => row.hit, 0.72);
  assert.equal(result.current.n, 1);
  assert.equal(result.historical.n, 1);
  assert.equal(result.p, 0.72);
});

test('los pesos de contexto ponderan resultados reales, no añaden puntos', () => {
  const result = empiricalRate([
    { hit: 1, _current: true, _weight: 2 },
    { hit: 0, _current: true, _weight: 1 },
  ], (row) => row.hit, 0.72);
  assert.equal(result.p, 2 / 3);
  assert.equal(result.hits, 1);
  assert.equal(result.n, 2);
});

test('un H2H compartido por ambos equipos cuenta una sola vez en el total', async () => {
  const kickoff = new Date('2026-01-01T12:00:00Z');
  const base = {
    fixture_id: 10, kickoff, season: 2026, competition_id: 39,
    total_goals: 2, btts: true, phase: 'regular', result: 'W',
    goals_for: 1, goals_against: 1, is_home: true,
  };
  const home = { ...base, team_id: 1, opponent_id: 2, is_home: true, result: 'D' };
  const away = { ...base, team_id: 2, opponent_id: 1, is_home: false, result: 'D' };
  const fakePool = {
    async query(_sql, params) {
      return { rows: Number(params[0]) === 1 ? [home] : [away] };
    },
  };
  const result = await computeBaseMarkets(fakePool, {
    fixtureId: 99, homeTeamId: 1, awayTeamId: 2, competitionId: 39,
    season: 2026, phase: 'regular', nTeams: 20, cutoff: new Date('2026-02-01T12:00:00Z'),
  }, { config: DEFAULT_ENGINE_CONFIG });
  assert.equal(result.markets.goals_total.lines[0].n, 1);
  assert.equal(result.markets.goals_total.lines[0].hits, 1);
  assert.equal(result.markets.goals_total.lines[0].prob, 1);
});

test('la proyección de cada equipo cruza ataque propio y concesión rival', async () => {
  const base = {
    kickoff: new Date('2026-01-01T12:00:00Z'), season: 2026,
    competition_id: 39, total_goals: 2, phase: 'regular', result: 'W',
  };
  const home = {
    ...base, fixture_id: 10, team_id: 1, opponent_id: 8,
    goals_for: 1, goals_against: 0, is_home: true,
  };
  const away = {
    ...base, fixture_id: 11, team_id: 2, opponent_id: 9,
    goals_for: 0, goals_against: 2, is_home: false,
  };
  const fakePool = {
    async query(_sql, params) { return { rows: Number(params[0]) === 1 ? [home] : [away] }; },
  };
  const result = await computeBaseMarkets(fakePool, {
    fixtureId: 99, homeTeamId: 1, awayTeamId: 2, competitionId: 39,
    season: 2026, phase: 'regular', nTeams: 20,
    cutoff: new Date('2026-02-01T12:00:00Z'),
  }, { config: { ...DEFAULT_ENGINE_CONFIG, venueBoost: 1, opponentTierBoost: 1, phaseBoost: 1, h2hBoost: 1 } });
  const lines = result.markets.goals_home.lines;
  assert.equal(lines[0].n, 2);
  assert.equal(lines[0].hits, 2);
  assert.equal(lines[1].n, 2);
  assert.equal(lines[1].hits, 1);
  assert.equal(lines[1].prob, 0.5);
});

test('el XI recibido en tiempo real entra en la capa de jugadores sin depender de una ingesta nocturna', () => {
  const rows = lineupRowsFromApi([
    {
      team: { id: 1 },
      startXI: [{ player: { id: 10 } }, { player: { id: 11 } }],
      substitutes: [{ player: { id: 12 } }],
    },
    { team: { id: 2 }, startXI: [{ player: { id: 20 } }], substitutes: [] },
  ]);
  assert.deepEqual(rows, [
    { player_id: 10, team_id: 1, is_starter: true },
    { player_id: 11, team_id: 1, is_starter: true },
    { player_id: 12, team_id: 1, is_starter: false },
    { player_id: 20, team_id: 2, is_starter: true },
  ]);
});

test('el XI solo pondera partidos reales con titulares parecidos', async () => {
  const pool = {
    async query() {
      return { rows: [
        { fixture_id: 10, team_id: 1, lineup_size: 11, matched: 2 },
        { fixture_id: 11, team_id: 1, lineup_size: 11, matched: 1 },
        { fixture_id: 20, team_id: 2, lineup_size: 11, matched: 1 },
      ] };
    },
  };
  const result = await annotateLineupSimilarity(pool, {
    homeRaw: [{ fixture_id: 10 }, { fixture_id: 11 }, { fixture_id: 12 }],
    awayRaw: [{ fixture_id: 20 }],
  }, [
    { team: { id: 1 }, startXI: [{ player: { id: 100 } }, { player: { id: 101 } }] },
    { team: { id: 2 }, startXI: [{ player: { id: 200 } }] },
  ], { homeTeamId: 1, awayTeamId: 2 });

  assert.equal(result.homeRaw[0]._lineupSimilarity, 1);
  assert.equal(result.homeRaw[1]._lineupSimilarity, 0.5);
  assert.equal(result.homeRaw[2]._lineupSimilarity, null);
  assert.equal(result.awayRaw[0]._lineupSimilarity, 1);
  assert.deepEqual(result.context, { homeStarters: 2, awayStarters: 1, historicalRows: 3 });
});

test('el árbitro pondera tarjetas reales pero no altera familias ajenas', async () => {
  const base = {
    team_id: 1,
    opponent_id: 8,
    kickoff: new Date('2026-01-01T12:00:00Z'),
    season: 2026,
    competition_id: 39,
    is_home: true,
    phase: 'regular',
    result: 'W',
    goals_for: 1,
    goals_against: 1,
    yellow_against: 0,
    red_for: 0,
    red_against: 0,
  };
  const rows = [
    { ...base, fixture_id: 10, referee: 'Árbitro A, Colombia', total_goals: 2, yellow_for: 1 },
    { ...base, fixture_id: 11, referee: 'Árbitro B', total_goals: 0, yellow_for: 0 },
  ];
  const fakePool = {
    async query(_sql, params) { return { rows: Number(params[0]) === 1 ? rows : [] }; },
  };
  const result = await computeBaseMarkets(fakePool, {
    fixtureId: 99, homeTeamId: 1, awayTeamId: 2, competitionId: 39,
    season: 2026, phase: 'regular', referee: 'Arbitro A', nTeams: 20,
    cutoff: new Date('2026-02-01T12:00:00Z'),
  }, { config: {
    ...DEFAULT_ENGINE_CONFIG,
    venueBoost: 1,
    opponentTierBoost: 1,
    phaseBoost: 1,
    h2hBoost: 1,
    refereeBoost: 2,
  } });
  assert.equal(result.markets.cards_total.lines[0].prob, 0.666667);
  assert.equal(result.markets.goals_total.lines[0].prob, 0.5);
});

test('primer gol excluye partidos con goles cuando faltan eventos, pero cuenta un 0-0 como no', async () => {
  const base = {
    team_id: 1,
    opponent_id: 8,
    kickoff: new Date('2026-01-01T12:00:00Z'),
    season: 2026,
    competition_id: 39,
    is_home: true,
    phase: 'regular',
    result: 'D',
    goals_for: 0,
    goals_against: 0,
    first_goal_minute: null,
  };
  const rows = [
    { ...base, fixture_id: 10, total_goals: 0 },
    { ...base, fixture_id: 11, total_goals: 1, goals_for: 1, result: 'W' },
  ];
  const fakePool = {
    async query(_sql, params) { return { rows: Number(params[0]) === 1 ? rows : [] }; },
  };
  const result = await computeBaseMarkets(fakePool, {
    fixtureId: 99, homeTeamId: 1, awayTeamId: 2, competitionId: 39,
    season: 2026, phase: 'regular', nTeams: 20,
    cutoff: new Date('2026-02-01T12:00:00Z'),
  }, { config: {
    ...DEFAULT_ENGINE_CONFIG,
    venueBoost: 1,
    opponentTierBoost: 1,
    phaseBoost: 1,
    h2hBoost: 1,
  } });
  assert.equal(result.markets.first_goal_1h.n, 1);
  assert.equal(result.markets.first_goal_1h.prob, 0);
});
