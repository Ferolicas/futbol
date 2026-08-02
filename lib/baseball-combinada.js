// "Apuesta del Día" baseball — agrega selecciones top across all games.
//
// IMPORTANTE — fuente unica de mercados:
//   El catalogo de mercados de un partido (selections con prob+cuota) lo
//   genera AHORA buildMultisportCombinada en lib/multisport-analysis.js. Este
//   archivo solo AGREGA esas selections en un ranking diario, sin
//   reconstruir el catalogo desde probs como hacia antes.

const isLive = (s) => ['LIVE', 'IN', 'IN1', 'IN2', 'IN3', 'IN4', 'IN5', 'IN6', 'IN7', 'IN8', 'IN9'].includes(s);
const isFinished = (s) => ['FT', 'AOT'].includes(s);
const rawProbability = (selection) => Number(selection?.rawProbability ?? selection?.probability) || 0;
const isBet365 = (selection) => String(selection?.bookmaker || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '') === 'bet365';
const isBettable = (selection) => isBet365(selection) && Number(selection?.odd) >= 1.20;

function gamePriority(g) {
  const s = g?.status?.short;
  if (isFinished(s)) return 0;
  if (isLive(s)) return 1;
  return 2;
}

/**
 * Apuesta del Día — top picks across all analyzed games.
 *
 * Lee `game.analysis.combinada.selections` (lo que genera buildMultisportCombinada
 * en el worker), filtra por threshold y agrupa por fixture (1 pick por partido,
 * el de mejor probabilidad). Top N total.
 */
export function buildBaseballApuestaDelDia(analyzedGames, { minProb = 90, maxPicks = 8 } = {}) {
  const candidates = [];

  for (const g of analyzedGames || []) {
    const sels = g.analysis?.combinada?.selections;
    if (!Array.isArray(sels)) continue;
    const matchName = `${g.teams?.home?.name || g.analysis?.home_team} vs ${g.teams?.away?.name || g.analysis?.away_team}`;
    const priority = gamePriority(g);

    for (const s of sels) {
      if (!isBettable(s)) continue;
      const raw = rawProbability(s);
      if (raw < minProb) continue;
      candidates.push({
        fixtureId: g.id,
        matchName,
        market: s.category || s.id,
        name: s.name,
        probability: s.probability,
        rawProbability: raw,
        odd: s.odd || null,
        cat: s.category,
        marketLabel: s.marketLabel || s.market,
        bookmaker: s.bookmaker,
        bookmakerMarket: s.bookmakerMarket || null,
        bookmakerSelection: s.bookmakerSelection || null,
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
    if (!ex || rawProbability(c) > rawProbability(ex)) byFixture.set(c.fixtureId, c);
  }

  const ranked = Array.from(byFixture.values())
    .sort((a, b) => (b.priority - a.priority) || (rawProbability(b) - rawProbability(a)))
    .slice(0, maxPicks);

  if (ranked.length === 0) return null;

  const combinedProbability = ranked.reduce((acc, r) => acc * (rawProbability(r) / 100), 1);
  const allHaveOdds = ranked.every(isBettable);
  const combinedOdd = allHaveOdds ? ranked.reduce((acc, r) => acc * r.odd, 1) : null;

  return {
    selections: ranked,
    combinedProbability: Math.round((combinedProbability * 100 + Number.EPSILON) * 100) / 100,
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
    const currentCatalog = Array.isArray(game.analysis?.combinada?.selectable)
      ? game.analysis.combinada.selectable
      : [];
    for (const [key] of Object.entries(markets)) {
      // El estado del navegador puede quedar viejo tras un refresco de cuotas.
      // Se relee la selección canónica del análisis actual y se elimina si
      // Bet365 ya no la publica o cayó por debajo del mínimo.
      const m = currentCatalog.find((market) => market.id === key);
      if (!isBettable(m)) continue;
      selections.push({
        matchName,
        market: m.marketLabel || m.market || key,
        name: m.name || m.pick || key,
        probability: m.probability,
        rawProbability: rawProbability(m),
        odd: m.odd || null,
        cat: m.category || '',
        marketLabel: m.marketLabel || m.market || '',
        bookmaker: m.bookmaker,
        bookmakerMarket: m.bookmakerMarket || null,
        bookmakerSelection: m.bookmakerSelection || null,
        fixtureId: Number(fid),
        marketKey: key,
        priority: gamePriority(game),
      });
    }
  }
  if (selections.length === 0) {
    return { selections: [], combinedProbability: 0, combinedOdd: null, hasRealOdds: false };
  }

  const combinedProbability = selections.reduce((acc, r) => acc * (rawProbability(r) / 100), 1);
  const allHaveOdds = selections.every(isBettable);
  const combinedOdd = allHaveOdds ? selections.reduce((acc, r) => acc * r.odd, 1) : null;

  return {
    selections,
    combinedProbability: Math.round((combinedProbability * 100 + Number.EPSILON) * 100) / 100,
    combinedOdd: combinedOdd ? +combinedOdd.toFixed(2) : null,
    hasRealOdds: allHaveOdds,
  };
}
