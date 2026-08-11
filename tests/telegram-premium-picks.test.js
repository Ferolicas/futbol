const test = require('node:test');
const assert = require('node:assert/strict');

let premium;
test.before(async () => {
  premium = await import('../lib/telegram-premium-picks.js');
});

const NOW = Date.parse('2026-08-11T10:00:00Z');
const FUTURE_KICKOFF = '2026-08-11T19:00:00Z';

// ---------------------------------------------------------------------------
// Clasificación fútbol: solo hándicap, córners y goles
// ---------------------------------------------------------------------------

test('fútbol clasifica hándicap asiático y europeo', () => {
  assert.equal(premium.classifyFootballPremiumOption({ id: 'ah_home_p0_5', name: 'Hándicap asiático — Local +0.5' }), 'handicap');
  assert.equal(premium.classifyFootballPremiumOption({ id: 'eh_home_p1', name: 'Hándicap europeo — Local +1' }), 'handicap');
});

test('fútbol clasifica córners y goles (totales, por equipo y mitades)', () => {
  assert.equal(premium.classifyFootballPremiumOption({ id: 'total_corners_under9_5', category: 'total_corners-under', name: 'Córners — Menos de 9.5' }), 'corners');
  assert.equal(premium.classifyFootballPremiumOption({ id: 'away_corners_over2_5', category: 'away_corners-over', name: 'Visitante — Córners a favor — Más de 2.5' }), 'corners');
  assert.equal(premium.classifyFootballPremiumOption({ id: 'total_goals_over1_5', category: 'total_goals-over', name: 'Total de goles — Más de 1.5' }), 'goles');
  assert.equal(premium.classifyFootballPremiumOption({ id: 'home_goals_under2_5', category: 'home_goals-under', name: 'Local — Goles a favor — Menos de 2.5' }), 'goles');
  assert.equal(premium.classifyFootballPremiumOption({ id: 'total_goals_1h_over0_5', category: 'total_goals_1h-over', name: 'Goles 1ª mitad — Más de 0.5' }), 'goles');
});

test('fútbol excluye btts, doble oportunidad, tarjetas, ganador y remates', () => {
  assert.equal(premium.classifyFootballPremiumOption({ id: 'btts', name: 'Ambos equipos marcan' }), null);
  assert.equal(premium.classifyFootballPremiumOption({ id: 'dc_12', name: 'Doble oportunidad — A o B (sin empate)' }), null);
  assert.equal(premium.classifyFootballPremiumOption({ id: 'total_cards_over3_5', category: 'total_cards-over', name: 'Tarjetas — Más de 3.5' }), null);
  assert.equal(premium.classifyFootballPremiumOption({ id: 'winner_home', name: 'Ganador del partido' }), null);
  assert.equal(premium.classifyFootballPremiumOption({ id: 'sot_over', name: 'Tiros a puerta — Más de 4.5' }), null);
});

// ---------------------------------------------------------------------------
// Elegibilidad fútbol: probabilidad >= 70 y fiabilidad >= 90
// ---------------------------------------------------------------------------

test('fútbol exige probabilidad desde 70 hacia arriba', () => {
  assert.equal(premium.isFootballPremiumEligible({ rawProbability: 69.9, confidence: 95 }), false);
  assert.equal(premium.isFootballPremiumEligible({ rawProbability: 70, confidence: 95 }), true);
  assert.equal(premium.isFootballPremiumEligible({ rawProbability: 96, confidence: 95 }), true);
});

test('fútbol exige fiabilidad >= 90', () => {
  assert.equal(premium.isFootballPremiumEligible({ rawProbability: 95, confidence: 89.99 }), false);
  assert.equal(premium.isFootballPremiumEligible({ rawProbability: 95, confidence: 90 }), true);
  assert.equal(premium.isFootballPremiumEligible({ rawProbability: 95, confidence: null }), false);
});

// ---------------------------------------------------------------------------
// Ensamblado fútbol
// ---------------------------------------------------------------------------

function footballRow(overrides = {}, selectable = []) {
  return {
    fixture_id: 100,
    cache_version: 22,
    combinada: { source: 'context-engine', selectable },
    analysis: {
      homeTeam: 'Local FC',
      awayTeam: 'Visitante FC',
      league: 'Liga Test',
      kickoff: FUTURE_KICKOFF,
      status: { short: 'NS' },
      _scored: {},
    },
    ...overrides,
  };
}

const fbOption = (overrides = {}) => ({
  id: 'ah_home_p0_5',
  name: 'Hándicap asiático — Local +0.5',
  probability: 92,
  rawProbability: 92,
  confidence: 94,
  odd: 1.4,
  ...overrides,
});

test('ensambla partido de fútbol con grupos ordenados por probabilidad', () => {
  const rows = [footballRow({}, [
    fbOption(),
    fbOption({ id: 'total_corners_under10_5', category: 'total_corners-under', name: 'Córners — Menos de 10.5', rawProbability: 93, probability: 93 }),
    fbOption({ id: 'total_goals_over0_5', category: 'total_goals-over', name: 'Más de 0.5 goles', rawProbability: 97, probability: 97 }),
    fbOption({ id: 'total_goals_over1_5', category: 'total_goals-over', name: 'Más de 1.5 goles', rawProbability: 91, probability: 91 }),
    fbOption({ id: 'btts', name: 'Ambos equipos marcan', rawProbability: 99 }),         // familia excluida
    fbOption({ id: 'total_goals_over2_5', category: 'total_goals-over', name: 'Más de 2.5 goles', rawProbability: 65 }), // no llega a 70
  ])];

  const matches = premium.assembleFootballPremiumMatches(rows, NOW);
  assert.equal(matches.length, 1);
  const match = matches[0];
  assert.equal(match.optionsCount, 4);
  assert.equal(match.groups.handicap.length, 1);
  assert.equal(match.groups.corners.length, 1);
  assert.equal(match.groups.goles.length, 2);
  assert.equal(match.groups.goles[0].rawProbability, 97);
  assert.equal(match.groups.goles[1].rawProbability, 91);
});

test('fútbol descarta partidos ya comenzados, no NS o sin context-engine', () => {
  const started = footballRow({ analysis: { ...footballRow().analysis, kickoff: '2026-08-11T09:00:00Z' } }, [fbOption()]);
  const finished = footballRow({ analysis: { ...footballRow().analysis, status: { short: 'FT' } } }, [fbOption()]);
  const foreign = footballRow({ combinada: { source: 'legacy', selectable: [fbOption()] } });
  assert.equal(premium.assembleFootballPremiumMatches([started, finished, foreign], NOW).length, 0);
});

test('fútbol recupera la fiabilidad desde la evidencia _scored', () => {
  const row = footballRow({
    analysis: {
      ...footballRow().analysis,
      _scored: { ah_home_p0_5: { confidence: 0.93 } },
    },
  }, [fbOption({ confidence: undefined })]);
  const matches = premium.assembleFootballPremiumMatches([row], NOW);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].groups.handicap[0].confidence, 93);
});

// ---------------------------------------------------------------------------
// Clasificación béisbol
// ---------------------------------------------------------------------------

test('béisbol clasifica carreras (partido, equipo, entradas y habrá carrera)', () => {
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'total-8.5' }), 'carreras');
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'team-total-home-4.5' }), 'carreras');
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'first5-total-4.5' }), 'carreras');
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'first5-team-total-away-2.5' }), 'carreras');
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'inning1-run' }), 'carreras');
});

test('béisbol clasifica únicamente hits, bateadores y strikeouts además de carreras', () => {
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'handicap--1.5' }), null);
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'first5-handicap--0.5' }), null);
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'stat-hits-total-8.5' }), 'hits');
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'stat-hits-home-4.5' }), 'hits');
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'player-hits-aaronjudge' }), 'bateadores');
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'player-totalBases-aaronjudge' }), 'bateadores');
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'player-strikeouts-gerritcole' }), 'strikeouts');
});

test('béisbol excluye ganador, hándicap y especiales pero conserva props de bateador', () => {
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'moneyline' }), null);
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'first5-moneyline' }), null);
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'special-total-parity' }), null);
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'special-correct-score' }), null);
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'player-homeRuns-aaronjudge' }), 'bateadores');
  assert.equal(premium.classifyBaseballPremiumOption({ category: 'player-battingStrikeouts-x' }), 'bateadores');
});

// ---------------------------------------------------------------------------
// Elegibilidad béisbol: probabilidad >= 70 y fiabilidad >= 90
// ---------------------------------------------------------------------------

test('béisbol exige probabilidad >= 70 y fiabilidad >= 90', () => {
  assert.equal(premium.isBaseballPremiumEligible({ rawProbability: 70, reliability: 90 }), true);
  assert.equal(premium.isBaseballPremiumEligible({ rawProbability: 69.9, reliability: 99 }), false);
  assert.equal(premium.isBaseballPremiumEligible({ rawProbability: 80, reliability: 89.9 }), false);
  assert.equal(premium.isBaseballPremiumEligible({ rawProbability: 80, reliability: null }), false);
});

// ---------------------------------------------------------------------------
// Ensamblado béisbol
// ---------------------------------------------------------------------------

const bbOption = (overrides = {}) => ({
  id: 'total-8.5-over',
  category: 'total-8.5',
  name: 'Más de 8.5 carreras',
  probability: 72,
  rawProbability: 72,
  reliability: 95,
  odd: 1.55,
  ...overrides,
});

function baseballRow(overrides = {}, selectable = [bbOption()]) {
  return {
    fixture_id: 777001,
    home_team: 'New York Yankees',
    away_team: 'Boston Red Sox',
    league_name: 'MLB',
    status: 'NS',
    start_time: '2026-08-11T23:10:00Z',
    combinada: { source: 'empirical-exact', selectable },
    ...overrides,
  };
}

test('ensambla juego de béisbol solo con las cuatro familias pedidas', () => {
  const rows = [baseballRow({}, [
    bbOption(),
    bbOption({ id: 'handicap-home--1.5', category: 'handicap--1.5', name: 'Yankees -1.5', rawProbability: 71 }),
    bbOption({ id: 'stat-hits-total-8.5-over', category: 'stat-hits-total-8.5', name: 'Ambos: más de 8.5 hits', rawProbability: 88 }),
    bbOption({ id: 'player-hits-judge-1.5-over', category: 'player-hits-aaronjudge', name: 'Judge: más de 0.5 hits', rawProbability: 75 }),
    bbOption({ id: 'player-strikeouts-cole-5.5-over', category: 'player-strikeouts-gerritcole', name: 'Cole: más de 5.5 ponches', rawProbability: 76 }),
    bbOption({ id: 'ml-home', category: 'moneyline', name: 'Yankees gana', rawProbability: 80 }),          // excluida
    bbOption({ id: 'total-7.5-over', category: 'total-7.5', name: 'Más de 7.5 carreras', rawProbability: 80, reliability: 80 }), // fiab < 90
  ])];

  const matches = premium.assembleBaseballPremiumMatches(rows, NOW);
  assert.equal(matches.length, 1);
  const match = matches[0];
  assert.equal(match.optionsCount, 4);
  assert.equal(match.groups.carreras.length, 1);
  assert.equal(match.groups.hits.length, 1);
  assert.equal(match.groups.bateadores.length, 1);
  assert.equal(match.groups.strikeouts.length, 1);
  assert.deepEqual(Object.keys(match.groups), ['carreras', 'hits', 'bateadores', 'strikeouts']);
});

test('béisbol publica carreras, bateadores y strikeouts sin exigir cuota', () => {
  const evidence = (hits, n = 100) => ({
    probability: hits,
    rawProbability: hits / 100,
    evidence: { hits, n, rawProbability: hits / n },
  });
  const rows = [baseballRow({
    combinada: { source: 'empirical-exact', selectable: [] },
    probabilities: {
      // Shape real persistido: la capa visual puede traer solo porcentajes,
      // mientras `evidence` conserva las entradas empíricas completas.
      totals: { lines: { '7.5': { over: 82, under: 18 } } },
      teamTotals: {
        home: { '2.5': { over: evidence(81), under: evidence(19) } },
        away: {},
      },
      players: {
        hits: [{
          id: 99,
          name: 'Aaron Judge',
          lineSides: { '0.5': { over: evidence(84), under: evidence(16) } },
        }],
        strikeouts: [{
          id: 77,
          name: 'Gerrit Cole',
          lineSides: { '4.5': { over: evidence(80), under: evidence(20) } },
        }],
      },
      pitchers: {
        home: { name: 'Gerrit Cole', stats: { era: 3.1, whip: 1.05, k9: 9.8 } },
      },
      evidence: {
        totals: { lines: { '7.5': { over: evidence(82), under: evidence(18) } } },
        teamTotals: {
          home: { '2.5': { over: evidence(81), under: evidence(19) } },
          away: {},
        },
      },
    },
  }, [])];

  const matches = premium.assembleBaseballPremiumMatches(rows, NOW);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].groups.carreras.length, 2);
  assert.equal(matches[0].groups.bateadores.length, 1);
  assert.equal(matches[0].groups.strikeouts.length, 1);
  assert.equal(matches[0].groups.bateadores[0].odd, null);
  assert.equal(matches[0].pitchers.home.name, 'Gerrit Cole');
});

test('béisbol descarta juegos ya comenzados y ordena por hora de inicio', () => {
  const started = baseballRow({ fixture_id: 1, start_time: '2026-08-11T09:00:00Z' });
  const late = baseballRow({ fixture_id: 2, start_time: '2026-08-12T00:10:00Z' });
  const early = baseballRow({ fixture_id: 3, start_time: '2026-08-11T22:05:00Z' });
  const matches = premium.assembleBaseballPremiumMatches([started, late, early], NOW);
  assert.deepEqual(matches.map((match) => match.fixtureId), [3, 2]);
});

test('béisbol usa el día de Bogotá aunque la fecha UTC cruce medianoche', () => {
  // 19:05 Bogotá del 11-ago = 00:05 UTC del 12-ago: pertenece al día 11.
  const eveningGame = baseballRow({ fixture_id: 10, start_time: '2026-08-12T00:05:00Z' });
  // Mediodía Bogotá del 12-ago: pertenece al día siguiente.
  const nextDayGame = baseballRow({ fixture_id: 11, start_time: '2026-08-12T17:05:00Z' });
  const matches = premium.assembleBaseballPremiumMatches([eveningGame, nextDayGame], NOW, '2026-08-11');
  assert.deepEqual(matches.map((match) => match.fixtureId), [10]);
});

test('shiftIsoDate avanza días y bogotaDayOf traduce a fecha de Bogotá', () => {
  assert.equal(premium.shiftIsoDate('2026-08-11', 1), '2026-08-12');
  assert.equal(premium.shiftIsoDate('2026-12-31', 1), '2027-01-01');
  assert.equal(premium.bogotaDayOf('2026-08-12T00:05:00Z'), '2026-08-11');
  assert.equal(premium.bogotaDayOf('2026-08-12T17:05:00Z'), '2026-08-12');
});

test('la probabilidad mostrada se topa en 95 y la fiabilidad no', () => {
  const rows = [baseballRow({}, [bbOption({ rawProbability: 98.4, probability: 95, reliability: 96.6 })])];
  const matches = premium.assembleBaseballPremiumMatches(rows, NOW);
  assert.equal(matches[0].groups.carreras[0].probability, 95);
  assert.equal(matches[0].groups.carreras[0].confidence, 96.6);
});
