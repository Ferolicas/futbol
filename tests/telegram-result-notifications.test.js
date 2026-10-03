const test = require('node:test');
const assert = require('node:assert/strict');

let buildTelegramMatchResult;

test.before(async () => {
  ({ buildTelegramMatchResult } = await import('../lib/telegram-result-notifications.js'));
});

const base = {
  dailyPickId: 'a8752625-62f8-4da8-b732-fb90bfa919b0',
  date: '2026-10-02',
  match: {
    fixtureId: 1528927,
    kickoff: '2026-10-02T19:00:00Z',
    homeTeam: 'Ukraine',
    awayTeam: 'Northern Ireland',
    options: [
      { id: 'total_corners_under11_5', name: 'Total córners — Menos de 11.5' },
      { id: 'away_goals_under2_5', name: 'Visitante — Menos de 2.5 goles' },
    ],
  },
};

test('liquida exactamente las opciones publicadas y genera ganado/perdido', () => {
  const result = buildTelegramMatchResult({
    ...base,
    result: {
      status: { short: 'FT' },
      goals: { home: 0, away: 3 },
      score: { fulltime: { home: 0, away: 3 }, halftime: { home: 0, away: 2 } },
      // El snapshot final puede llegar antes de que el proveedor complete las estadísticas.
      corners: { home: null, away: null, total: null },
      yellow_cards: { home: 3, away: 1, total: 4 },
      red_cards: { home: 0, away: 0, total: 0 },
    },
    liveStats: { corners: { home: 7, away: 1, total: 8, isReal: true } },
  });
  assert.ok(result);
  assert.equal(result.won, 1);
  assert.equal(result.lost, 1);
  assert.deepEqual(result.options.map(option => option.outcome.status), ['won', 'lost']);
  assert.match(result.message, /✅ GANADA/);
  assert.match(result.message, /❌ PERDIDA/);
  assert.match(result.message, /Ukraine 0–3 Northern Ireland/);
});

test('espera si el partido no terminó o falta una estadística oficial', () => {
  assert.equal(buildTelegramMatchResult({
    ...base,
    result: { status: { short: '2H' }, goals: { home: 0, away: 3 } },
    liveStats: { corners: { home: 7, away: 1, total: 8, isReal: true } },
  }), null);

  assert.equal(buildTelegramMatchResult({
    ...base,
    result: {
      status: { short: 'FT' }, goals: { home: 0, away: 3 },
      score: { fulltime: { home: 0, away: 3 } },
    },
  }), null);
});

test('escapa nombres antes de enviarlos como HTML de Telegram', () => {
  const result = buildTelegramMatchResult({
    ...base,
    match: {
      ...base.match,
      homeTeam: '<Local>',
      options: [{ id: 'total_goals_under4_5', name: '<b>mercado</b>' }],
    },
    result: {
      status: { short: 'FT' }, goals: { home: 1, away: 1 },
      score: { fulltime: { home: 1, away: 1 } },
    },
  });
  assert.match(result.message, /&lt;Local&gt;/);
  assert.match(result.message, /&lt;b&gt;mercado&lt;\/b&gt;/);
  assert.doesNotMatch(result.message, /<b>mercado<\/b>/);
});
