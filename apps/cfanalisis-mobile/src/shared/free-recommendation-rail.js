import { marketResultState, settleMarketSelection } from './market-settlement.js';

const fixtureId = (sport, game) => sport === 'football'
  ? game?.fixture?.id
  : game?.id;

const matchName = (game) => {
  const home = game?.teams?.home?.name || game?.home_team || '';
  const away = game?.teams?.away?.name || game?.away_team || '';
  return `${home} vs ${away}`;
};

const namedBookmaker = value => {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  return !!normalized && !['bet365/bwin', 'unknown', 'desconocida', 'estimated', 'estimada'].includes(normalized);
};

// Reutiliza exclusivamente la selección que ya atravesó la frontera Free.
// Nunca consulta ni reconstruye el catálogo Pro dentro del navegador.
export function freeRecommendationForRail({ sport, game, analysis, liveResult = null }) {
  const selection = analysis?.freePreview?.selection;
  const odd = Number(selection?.odd);
  const bookmaker = String(selection?.bookmaker || '').trim();
  if (!selection?.id || !selection?.name || !Number.isFinite(odd) || odd < 1.2 || !namedBookmaker(bookmaker)) return null;
  const resultState = marketResultState({ sport, game, liveResult });
  return {
    ...selection,
    fixtureId: fixtureId(sport, game),
    matchName: matchName(game),
    marketKey: selection.id,
    odd,
    bookmaker,
    resultState,
    outcome: selection.outcome || settleMarketSelection({ sport, selection, game, liveResult }),
  };
}
