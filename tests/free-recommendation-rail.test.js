const test = require('node:test');
const assert = require('node:assert/strict');

const selection = {
  id: 'total_goals_over2_5',
  name: 'Más de 2.5 goles',
  probability: 65,
  odd: 1.55,
  bookmaker: 'Bet365',
};

test('la tira Gratis reutiliza la única recomendación segura en los cuatro deportes', async () => {
  const { freeRecommendationForRail } = await import('../lib/free-recommendation-rail.js');
  const football = {
    fixture: { id: 10, status: { short: 'NS' } },
    teams: { home: { name: 'Local' }, away: { name: 'Visitante' } },
  };
  const other = {
    id: 20,
    status: { short: 'NS' },
    teams: { home: { name: 'Local' }, away: { name: 'Visitante' } },
  };
  for (const [sport, game] of [
    ['football', football],
    ['baseball', other],
    ['basketball', other],
    ['american_football', other],
  ]) {
    const result = freeRecommendationForRail({
      sport,
      game,
      analysis: { freePreview: { selection } },
    });
    assert.equal(result.fixtureId, sport === 'football' ? 10 : 20);
    assert.equal(result.matchName, 'Local vs Visitante');
    assert.equal(result.odd, 1.55);
    assert.equal(result.bookmaker, 'Bet365');
    assert.equal(result.resultState.isFinal, false);
    assert.equal(result.outcome.status, 'pending');
  }
});

test('la tira Gratis no inventa recomendaciones sin cuota o casa real', async () => {
  const { freeRecommendationForRail } = await import('../lib/free-recommendation-rail.js');
  const game = {
    fixture: { id: 10, status: { short: 'NS' } },
    teams: { home: { name: 'A' }, away: { name: 'B' } },
  };
  for (const invalid of [
    { ...selection, odd: null },
    { ...selection, odd: 1.19 },
    { ...selection, bookmaker: '' },
    { ...selection, bookmaker: 'Bet365/Bwin' },
  ]) {
    assert.equal(freeRecommendationForRail({
      sport: 'football', game, analysis: { freePreview: { selection: invalid } },
    }), null);
  }
});
