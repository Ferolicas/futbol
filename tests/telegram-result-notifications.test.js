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

test('formatea las opciones exactas con los resultados won/lost ya guardados por la web', () => {
  const result = buildTelegramMatchResult({
    ...base,
    outcomes: [
      { marketKey: 'total_corners_under11_5', outcome: 'won' },
      { marketKey: 'away_goals_under2_5', outcome: 'lost' },
    ],
  });
  assert.ok(result);
  assert.equal(result.combinadaId, base.dailyPickId);
  assert.equal(result.won, 1);
  assert.equal(result.lost, 1);
  assert.deepEqual(result.options.map(option => option.status), ['won', 'lost']);
  assert.match(result.message, /✅ GANADA/);
  assert.match(result.message, /❌ PERDIDA/);
  assert.match(result.message, /Ukraine vs Northern Ireland/);
});

test('espera mientras la web no tenga won/lost para todas las opciones enviadas', () => {
  assert.equal(buildTelegramMatchResult({
    ...base,
    outcomes: [{ marketKey: 'total_corners_under11_5', outcome: 'won' }],
  }), null);

  assert.equal(buildTelegramMatchResult({
    ...base,
    outcomes: [
      { marketKey: 'total_corners_under11_5', outcome: 'won' },
      { marketKey: 'away_goals_under2_5', outcome: 'void' },
    ],
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
    outcomes: [{ marketKey: 'total_goals_under4_5', outcome: 'won' }],
  });
  assert.match(result.message, /&lt;Local&gt;/);
  assert.match(result.message, /&lt;b&gt;mercado&lt;\/b&gt;/);
  assert.doesNotMatch(result.message, /<b>mercado<\/b>/);
});
