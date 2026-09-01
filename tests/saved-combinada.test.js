const test = require('node:test');
const assert = require('node:assert/strict');

const {
  groupSavedCombinadaSelections,
  savedSelectionMatchName,
} = require('../lib/saved-combinada.js');

test('conserva el encabezado de equipos de una selección guardada', () => {
  assert.equal(
    savedSelectionMatchName({ matchName: 'Real Madrid vs Barcelona' }),
    'Real Madrid vs Barcelona',
  );
});

test('agrupa mercados del mismo partido y mantiene partidos distintos separados', () => {
  const groups = groupSavedCombinadaSelections([
    { fixtureId: '10', matchName: 'Real Madrid vs Barcelona', market: 'Más de 2.5' },
    { fixtureId: '10', matchName: 'Real Madrid vs Barcelona', market: 'Más de 8.5 córners' },
    { fixtureId: '11', matchName: 'Milan vs Inter', market: 'Más de 3.5 tarjetas' },
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].matchName, 'Real Madrid vs Barcelona');
  assert.equal(groups[0].selections.length, 2);
  assert.equal(groups[1].matchName, 'Milan vs Inter');
  assert.equal(groups[1].selections.length, 1);
});

test('reconstruye equipos estructurados y da contexto a registros antiguos', () => {
  assert.equal(
    savedSelectionMatchName({ homeTeam: 'Arsenal', awayTeam: 'Chelsea' }),
    'Arsenal vs Chelsea',
  );
  assert.equal(savedSelectionMatchName({ fixtureId: 99 }), 'Partido 99');
});
