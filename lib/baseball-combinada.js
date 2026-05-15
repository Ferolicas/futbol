// "Apuesta del Día" baseball — agrega selecciones top across all games.
//
// IMPORTANTE — fuente unica de mercados:
//   El catalogo de mercados de un partido (selections con prob+cuota) lo
//   genera AHORA buildBaseballCombinada en lib/baseball-model.js. Este
//   archivo solo AGREGA esas selections en un ranking diario, sin
//   reconstruir el catalogo desde probs como hacia antes.

const isLive = (s) => ['LIVE', 'IN', 'IN1', 'IN2', 'IN3', 'IN4', 'IN5', 'IN6', 'IN7', 'IN8', 'IN9'].includes(s);
const isFinished = (s) => ['FT', 'AOT'].includes(s);

function gamePriority(g) {
  const s = g?.status?.short;
  if (isFinished(s)) return 0;
  if (isLive(s)) return 1;
  return 2;
}

/**
 * Apuesta del Día — top picks across all analyzed games.
 *
 * Lee `game.analysis.combinada.selections` (lo que genera buildBaseballCombinada
 * en el worker), filtra por threshold y agrupa por fixture (1 pick por partido,
 * el de mejor probabilidad). Top N total.
 */
export function buildBaseballApuestaDelDia(analyzedGames, { minProb = 70, maxPicks = 8 } = {}) {
  const candidates = [];

  for (const g of analyzedGames || []) {
    const sels = g.analysis?.combinada?.selections;
    if (!Array.isArray(sels)) continue;
    const matchName = `${g.teams?.home?.name || g.analysis?.home_team} vs ${g.teams?.away?.name || g.analysis?.away_team}`;
    const priority = gamePriority(g);

    for (const s of sels) {
      if (s.probability < minProb) continue;
      candidates.push({
        fixtureId: g.id,
        matchName,
        market: s.category || s.id,
        name: s.name,
        probability: s.probability,
        odd: s.odd || null,
        cat: s.category,
        priority,
        _line: s._line,
      });
    }
  }

  if (candidates.length === 0) return null;

  // Dedupe por fixture: 1 pick por partido (el de mejor prob)
  const byFixture = new Map();
  for (const c of candidates) {
    const ex = byFixture.get(c.fixtureId);
    if (!ex || c.probability > ex.probability) byFixture.set(c.fixtureId, c);
  }

  const ranked = Array.from(byFixture.values())
    .sort((a, b) => (b.priority - a.priority) || (b.probability - a.probability))
    .slice(0, maxPicks);

  if (ranked.length === 0) return null;

  const combinedProbability = ranked.reduce((acc, r) => acc * (r.probability / 100), 1);
  const allHaveOdds = ranked.every(r => r.odd && r.odd > 1);
  const combinedOdd = allHaveOdds ? ranked.reduce((acc, r) => acc * r.odd, 1) : null;

  return {
    selections: ranked,
    combinedProbability: Math.round(combinedProbability * 100),
    combinedOdd: combinedOdd ? +combinedOdd.toFixed(2) : null,
    hasRealOdds: allHaveOdds,
  };
}

/**
 * Custom combinada — selecciones manuales por usuario.
 * selectedMarkets shape: { fixtureId: { marketKey: { label, probability, odd, cat } } }
 */
export function buildCustomBaseballCombinada(selectedMarkets, gamesById) {
  const selections = [];
  for (const [fid, markets] of Object.entries(selectedMarkets || {})) {
    const game = gamesById[fid];
    if (!game) continue;
    const matchName = `${game.teams?.home?.name || game.analysis?.home_team} vs ${game.teams?.away?.name || game.analysis?.away_team}`;
    for (const [key, m] of Object.entries(markets)) {
      selections.push({
        matchName,
        market: m.label || key,
        name: m.name || m.label || key,
        probability: m.probability,
        odd: m.odd || null,
        cat: m.cat || '',
        fixtureId: Number(fid),
        marketKey: key,
        priority: gamePriority(game),
      });
    }
  }
  if (selections.length === 0) {
    return { selections: [], combinedProbability: 0, combinedOdd: null, hasRealOdds: false };
  }

  const combinedProbability = selections.reduce((acc, r) => acc * (r.probability / 100), 1);
  const allHaveOdds = selections.every(r => r.odd && r.odd > 1);
  const combinedOdd = allHaveOdds ? selections.reduce((acc, r) => acc * r.odd, 1) : null;

  return {
    selections,
    combinedProbability: Math.round(combinedProbability * 100),
    combinedOdd: combinedOdd ? +combinedOdd.toFixed(2) : null,
    hasRealOdds: allHaveOdds,
  };
}
