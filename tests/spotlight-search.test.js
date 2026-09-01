const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { toggleSpotlightSport } = require('../lib/spotlight-sports.js');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('un segundo toque deselecciona el deporte realmente', () => {
  const selected = toggleSpotlightSport([], 'football');
  assert.deepEqual(selected, ['football']);
  assert.deepEqual(toggleSpotlightSport(selected, 'football'), []);
});

test('buscar abre directamente una sola superficie completa', () => {
  const source = read('app/dashboard/components/AppleSpotlightSearch.js');
  assert.match(source, /const openSearch = useCallback/);
  assert.match(source, /className="spotlight-stage is-expanded"/);
  assert.match(source, /className="spotlight-command is-expanded"/);
  assert.doesNotMatch(source, /openCompact|setExpanded|spotlight-launchers/);
});

test('el estado visual de los deportes sigue el aria-pressed real', () => {
  const styles = read('app/globals.css');
  assert.match(styles, /\.spotlight-sport-chip\[aria-pressed="true"\]/);
  assert.match(styles, /\.spotlight-sport-chip\[aria-pressed="false"\]/);
  assert.doesNotMatch(styles, /spotlight-launchers|spotlight-stage-hint/);
});
