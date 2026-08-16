const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('el filtro distingue todas, ninguna y una selección personalizada', async () => {
  const {
    leagueSelectionIncludes,
    normalizeLeagueSelection,
  } = await import('../lib/league-view-filter.js');

  assert.equal(normalizeLeagueSelection(null), null);
  assert.deepEqual(normalizeLeagueSelection([]), []);
  assert.deepEqual(normalizeLeagueSelection([39, '39', 140]), ['39', '140']);
  assert.equal(leagueSelectionIncludes(null, 999), true);
  assert.equal(leagueSelectionIncludes([], 39), false);
  assert.equal(leagueSelectionIncludes(['39', '140'], 140), true);
});

test('al desmarcar desde Todas conserva las demás ligas conocidas', async () => {
  const { toggleLeagueSelection } = await import('../lib/league-view-filter.js');

  assert.deepEqual(toggleLeagueSelection(null, 140, [39, 140, 253]), ['39', '253']);
  assert.deepEqual(toggleLeagueSelection(['39'], 140, [39, 140, 253]), ['39', '140']);
  assert.deepEqual(toggleLeagueSelection(['39', '140'], 39, [39, 140, 253]), ['140']);
});

test('el endpoint persiste el arreglo vacío en PostgreSQL y no lo convierte en Todas', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../app/api/user/leagues/route.js'),
    'utf8',
  );
  assert.match(source, /Array\.isArray\(profile\?\.custom_league_ids\)/);
  assert.match(source, /SET custom_league_ids = \$1::integer\[\]/);
  assert.doesNotMatch(source, /validIds\.length > 0 \? validIds : null/);
});

test('el dashboard aplica estado y multiselección solo como filtros de vista', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/dashboard/page.js'), 'utf8');
  assert.match(source, /leagueSelectionIncludes\(leagueFilter, f\.league\.id\)/);
  assert.match(source, /multiple\s*\n\s*allLeagueIds=/);
  assert.match(source, /leagueIds: normalized === null \? null : normalized\.map\(Number\)/);
});

test('el layout mantiene el botón Arriba junto al soporte en todas las vistas', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/dashboard/layout.js'), 'utf8');
  assert.match(source, /<ScrollToTopButton \/>\s*<ChatWidget \/>/);
});
