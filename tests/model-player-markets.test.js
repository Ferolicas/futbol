const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPlayerMarkets } = require('../lib/model-player-markets.js');

test('una sola aparición con cero tiros sigue siendo evidencia y genera la línea 0.5', async () => {
  const fakePool = {
    async query() {
      return { rows: [{
        player_id: 10,
        kickoff: new Date('2026-01-01T12:00:00Z'),
        season: 2026,
        goals: 0,
        shots_total: 0,
        shots_on: 0,
        yellow: 0,
        red: 0,
        fouls_committed: 0,
      }] };
    },
  };
  const result = await buildPlayerMarkets(fakePool, [
    { player_id: 10, team_id: 1, name: 'Jugador' },
  ], { cutoff: new Date('2026-02-01T12:00:00Z'), season: 2026 });

  assert.equal(result[10].n, 1);
  assert.equal(result[10].markets.shots.lines[0].line, 0.5);
  assert.equal(result[10].markets.shots.lines[0].prob, 0);
  assert.equal(result[10].markets.shots_on.lines[0].prob, 0);
  assert.equal(result[10].markets.fouls.lines[0].prob, 0);
});
