const test = require('node:test');
const assert = require('node:assert/strict');

const helperPromise = import('../apps/cfanalisis-worker/src/jobs/futbol/live-player-activity.js');

function player(id, name, { shots = null, on = null, fouls = null } = {}) {
  return {
    player: { id, name },
    statistics: [{ shots: { total: shots, on }, fouls: { committed: fouls } }],
  };
}

test('extrae remates y faltas por jugador sin convertir null en datos inventados', async () => {
  const { extractPlayerActivity } = await helperPromise;
  const rows = extractPlayerActivity([
    {
      team: { id: 10, name: 'Local' },
      players: [player(7, 'Ana Gol', { shots: 2, on: 1, fouls: null })],
    },
  ]);

  assert.deepEqual(rows[0], {
    key: 'id:7',
    playerId: 7,
    player: 'Ana Gol',
    teamId: 10,
    teamName: 'Local',
    shots: 2,
    shotsOnTarget: 1,
    fouls: 0,
  });
});

test('atribuye solo incrementos nuevos y separa remate de remate a puerta', async () => {
  const { diffPlayerActivity } = await helperPromise;
  const previous = [{ key: 'id:7', playerId: 7, player: 'Ana Gol', teamId: 10, teamName: 'Local', shots: 1, shotsOnTarget: 0, fouls: 0 }];
  const current = [{ key: 'id:7', playerId: 7, player: 'Ana Gol', teamId: 10, teamName: 'Local', shots: 3, shotsOnTarget: 1, fouls: 2 }];

  assert.deepEqual(diffPlayerActivity(previous, current).map(({ type, count, counter }) => ({ type, count, counter })), [
    { type: 'shot_on_target', count: 1, counter: 1 },
    { type: 'shot', count: 1, counter: 3 },
    { type: 'foul', count: 2, counter: 2 },
  ]);
});

test('un jugador nuevo crea baseline y un snapshot parcial conserva al equipo ausente', async () => {
  const { diffPlayerActivity, mergePlayerActivity } = await helperPromise;
  const previous = [
    { key: 'id:1', playerId: 1, player: 'Local', teamId: 10, teamName: 'A', shots: 0, shotsOnTarget: 0, fouls: 0 },
    { key: 'id:2', playerId: 2, player: 'Visitante', teamId: 20, teamName: 'B', shots: 1, shotsOnTarget: 0, fouls: 1 },
  ];
  const partial = [
    { key: 'id:1', playerId: 1, player: 'Local', teamId: 10, teamName: 'A', shots: 1, shotsOnTarget: 0, fouls: 0 },
    { key: 'id:3', playerId: 3, player: 'Suplente', teamId: 10, teamName: 'A', shots: 1, shotsOnTarget: 1, fouls: 0 },
  ];
  const merged = mergePlayerActivity(previous, partial);

  assert.equal(merged.some(row => row.playerId === 2), true);
  assert.deepEqual(diffPlayerActivity(previous, merged).map(change => change.playerId), [1]);
});

test('correcciones descendentes del proveedor no generan eventos falsos ni rebote posterior', async () => {
  const { diffPlayerActivity, mergePlayerActivity } = await helperPromise;
  const previous = [{ key: 'id:7', playerId: 7, player: 'Ana', teamId: 10, teamName: 'A', shots: 4, shotsOnTarget: 2, fouls: 3 }];
  const transient = [{ key: 'id:7', playerId: 7, player: 'Ana', teamId: 10, teamName: 'A', shots: 3, shotsOnTarget: 1, fouls: 2 }];
  const stabilized = mergePlayerActivity(previous, transient);

  assert.deepEqual(diffPlayerActivity(previous, stabilized), []);
  assert.deepEqual(stabilized[0], previous[0]);
  assert.deepEqual(diffPlayerActivity(stabilized, previous), []);
});
