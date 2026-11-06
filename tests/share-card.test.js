import test from 'node:test';
import assert from 'node:assert/strict';

import { shareableLogoUrl, sharePicksFromAnalysis } from '../app/dashboard/utils/share-card.js';

const pick = (id, category, probability, odd = 1.5) => ({ id, category, name: `Opción ${id}`, rawProbability: probability, odd, bookmaker: 'Bet365' });

test('compartir: una opción por familia de mercado, de mayor a menor probabilidad', () => {
  const picks = sharePicksFromAnalysis({ combinada: { selectable: [
    pick('total-199.5-over', 'total-199.5', 90), pick('total-200.5-over', 'total-200.5', 89),
    pick('handicap-home-7_5', 'handicap-7.5', 80), pick('ml-home', 'moneyline', 97),
    pick('quarter1-total-54.5-under', 'quarter1-total-54.5', 71), pick('team-total-away-99.5-over', 'team-total-away-99.5', 85),
  ] } });
  assert.deepEqual(picks.map((entry) => entry.id), ['ml-home', 'total-199.5-over', 'team-total-away-99.5-over', 'handicap-home-7_5']);
  assert.equal(picks[0].probability, 95, 'tope visual del 95%');
});

test('compartir: si el usuario marcó opciones del partido, se comparten esas', () => {
  const analysis = { combinada: { selectable: [pick('a', 'total-1', 90), pick('b', 'total-2', 70), pick('c', 'moneyline', 80)] } };
  assert.deepEqual(sharePicksFromAnalysis(analysis, { b: true }).map((entry) => entry.id), ['b']);
  assert.equal(sharePicksFromAnalysis(analysis, {}).length, 2);
});

test('compartir: el plan Free solo comparte la opción visible', () => {
  const free = { access: 'free', freePreview: { selection: { id: 'x', name: 'Visible', probability: 66.4, odd: 1.44, bookmaker: 'Bet365' }, locked: [{ probability: 91 }] },
    combinada: { selectable: [pick('oculta', 'moneyline', 91)] } };
  assert.deepEqual(sharePicksFromAnalysis(free).map((entry) => entry.name), ['Visible']);
  assert.deepEqual(sharePicksFromAnalysis({ access: 'free', freePreview: { selection: null } }), []);
  assert.deepEqual(sharePicksFromAnalysis(null), []);
});

test('compartir: el escudo de la NBA se cambia por uno que admite copia', () => {
  assert.equal(shareableLogoUrl({ logo: 'https://cdn.nba.com/logos/nba/1610612744/primary/L/logo.svg' }), 'https://a.espncdn.com/i/teamlogos/nba/500/gs.png');
  assert.equal(shareableLogoUrl({ logo: 'https://media.api-sports.io/football/teams/33.png' }), 'https://media.api-sports.io/football/teams/33.png');
  assert.equal(shareableLogoUrl({}), null);
});
