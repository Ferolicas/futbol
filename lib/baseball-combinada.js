// "Apuesta del Día" baseball — agrega selecciones top across all games.
//
// IMPORTANTE — fuente unica de mercados:
//   El catalogo de mercados de un partido (selections con prob+cuota) lo
//   genera AHORA buildMultisportCombinada en lib/multisport-analysis.js. Este
//   archivo solo AGREGA esas selections en un ranking diario, sin
//   reconstruir el catalogo desde probs como hacia antes.

import {
  BASEBALL_DAILY_MIN_PROBABILITY,
  BASEBALL_DAILY_MIN_RELIABILITY,
} from './recommendation-policy.js';

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
export function buildBaseballApuestaDelDia(analyzedGames, {
  minProb = BASEBALL_DAILY_MIN_PROBABILITY,
  minReliability = BASEBALL_DAILY_MIN_RELIABILITY,
  maxPicks = null,
} = {}) {
  const candidates = [];

  for (const g of analyzedGames || []) {
    // Se lee el catálogo COMPLETO (`selectable`), no el resumen `selections`:
    // ese venía recortado a tres mercados por partido y a uno por categoría, así
    // que los props de bateadores, los ponches del lanzador y las líneas de
    // carreras nunca podían llegar hasta aquí.
    const catalog = Array.isArray(g.analysis?.combinada?.selectable)
      ? g.analysis.combinada.selectable
      : [];
    if (!catalog.length) continue;
    const matchName = `${g.teams?.home?.name || g.analysis?.home_team} vs ${g.teams?.away?.name || g.analysis?.away_team}`;
    const priority = gamePriority(g);

    for (const s of catalog) {
      if (!isBettable(s)) continue;
      const raw = rawProbability(s);
      if (raw < minProb) continue;
      // Sin muestra que lo respalde, un porcentaje alto no se publica.
      const reliability = Number(s?.reliability);
      if (!Number.isFinite(reliability) || reliability + Number.EPSILON < minReliability) continue;
      candidates.push({
        fixtureId: g.id,
        matchName,
        market: s.category || s.id,
        name: s.name,
        probability: s.probability,
        rawProbability: raw,
        reliability,
        sampleN: s.sampleN ?? null,
        sampleHits: s.sampleHits ?? null,
        scope: s.scope || 'match',
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

  // Ya no se recorta a un pick por partido: si un encuentro tiene seis mercados
  // que cumplen probabilidad y fiabilidad, los seis son recomendables y los seis
  // salen. Solo se descarta la línea repetida (mismo partido y mismo mercado).
  const seen = new Set();
  const ranked = candidates
    .filter((c) => {
      const key = `${c.fixtureId}:${c.market}:${c.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.priority - a.priority)
      || (rawProbability(b) - rawProbability(a))
      || (Number(b.reliability) - Number(a.reliability)));

  const limited = Number.isFinite(Number(maxPicks)) && Number(maxPicks) > 0
    ? ranked.slice(0, Number(maxPicks))
    : ranked;

  if (limited.length === 0) return null;

  // La combinada del día sigue siendo una parlay corta y de partidos distintos:
  // multiplicar cuarenta selecciones daría una probabilidad conjunta ridícula.
  // El listado completo se publica igualmente en `selections`.
  const parlayFixtures = new Set();
  const parlay = limited.filter((c) => {
    if (parlayFixtures.has(c.fixtureId)) return false;
    parlayFixtures.add(c.fixtureId);
    return true;
  }).slice(0, 3);

  const combinedProbability = parlay.reduce((acc, r) => acc * (rawProbability(r) / 100), 1);
  const allHaveOdds = parlay.length > 0 && parlay.every(isBettable);
  const combinedOdd = allHaveOdds ? parlay.reduce((acc, r) => acc * r.odd, 1) : null;

  return {
    selections: limited,
    parlay,
    minProbability: minProb,
    minReliability,
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
