const test = require('node:test');
const assert = require('node:assert/strict');

test('liquida exactamente las opciones del snapshot Premium de fútbol', async () => {
  const { buildTelegramPremiumMatchResults } = await import('../lib/telegram-premium-results.js');
  const events = buildTelegramPremiumMatchResults({
    publicationId: '11111111-1111-4111-8111-111111111111',
    sport: 'football',
    date: '2026-10-04',
    match: {
      fixtureId: 100,
      homeTeam: 'Local', awayTeam: 'Visitante', kickoff: '2026-10-04T18:00:00Z',
      groups: {
        goles: [{ id: 'total_goals_over1_5', name: 'Más de 1.5 goles' }],
        handicap: [{ id: 'ah_home_p1_5', name: 'Local +1.5' }],
      },
    },
    result: { status: 'FT', goals: { home: 1, away: 1 }, score: { fulltime: { home: 1, away: 1 } } },
  });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].options.map(option => [option.id, option.outcome.status]), [
    ['total_goals_over1_5', 'won'],
    ['ah_home_p1_5', 'won'],
  ]);
  assert.match(events[0].message, /RESULTADOS PICKS PREMIUM/);
  assert.doesNotMatch(events[0].message, /Apuesta del día/i);
});

test('liquida béisbol con línea y lado preservados en la opción enviada', async () => {
  const { buildTelegramPremiumMatchResults } = await import('../lib/telegram-premium-results.js');
  const events = buildTelegramPremiumMatchResults({
    publicationId: '22222222-2222-4222-8222-222222222222',
    sport: 'baseball',
    date: '2026-10-04',
    match: {
      fixtureId: 200,
      homeTeam: 'Home', awayTeam: 'Away', kickoff: '2026-10-04T20:00:00Z',
      groups: { carreras: [{ id: 'total-7.5-over', name: 'Más de 7.5 carreras', line: 7.5, side: 'over' }] },
    },
    result: { status: 'FT', inning: 9, home_score: 5, away_score: 3, innings: [] },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].options[0].outcome.status, 'won');
  assert.match(events[0].message, /Home 5–3 Away/);
});

test('no crea resultados desde un partido final si alguna opción enviada sigue sin dato oficial', async () => {
  const { buildTelegramPremiumMatchResults } = await import('../lib/telegram-premium-results.js');
  const events = buildTelegramPremiumMatchResults({
    publicationId: '33333333-3333-4333-8333-333333333333',
    sport: 'football', date: '2026-10-04',
    match: {
      fixtureId: 300, homeTeam: 'A', awayTeam: 'B', kickoff: '2026-10-04T20:00:00Z',
      groups: { corners: [{ id: 'total_corners_over8_5', name: 'Más de 8.5 córners' }] },
    },
    result: { status: 'FT', goals: { home: 1, away: 0 }, score: { fulltime: { home: 1, away: 0 } } },
  });
  assert.deepEqual(events, []);
});
