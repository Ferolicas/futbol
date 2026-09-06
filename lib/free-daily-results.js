import { buildBaseballApuestaDelDia } from './baseball-combinada.js';
import { isFootballFrontendDailyPickEligible } from './recommendation-policy.js';
import { isTelegramMarketAllowed } from './telegram-daily-pick.js';
import { marketLabel } from './market-labels.js';
import { marketResultState, settleMarketSelection } from './market-settlement.js';

const namedBookmaker = value => {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  return !!normalized && !['bet365/bwin', 'unknown', 'desconocida', 'estimated', 'estimada'].includes(normalized);
};

// Excepción de lectura Free exclusivamente para Apuesta del día ya finalizada.
// Se filtra antes de serializar; nunca se envía el catálogo Pro ni su evidencia.
export function freeDailyResults({ sport, fixtures = [], analyzedData = {}, liveStats = {} }) {
  const football = sport === 'football';
  const finalGames = fixtures.filter(game => marketResultState({
    sport, game, liveResult: football ? liveStats[game.fixture?.id] : game.liveResult,
  }).isFinal);
  const gamesById = new Map(finalGames.map(game => [String(football ? game.fixture.id : game.id), game]));
  const candidates = football ? finalGames.flatMap(game => {
    const combinada = analyzedData[game.fixture.id]?.combinada;
    if (combinada?.source !== 'context-engine') return [];
    return (combinada.selectable || combinada.selections || [])
      .filter(selection => isTelegramMarketAllowed(selection)
        && isFootballFrontendDailyPickEligible(selection)
        && namedBookmaker(selection.bookmaker))
      .map(selection => ({ ...selection, fixtureId: game.fixture.id,
        name: selection.scope === 'context'
          ? marketLabel(selection.id, { home: game.teams.home.name, away: game.teams.away.name }) : selection.name,
      }));
  }) : (buildBaseballApuestaDelDia(finalGames)?.selections || []);

  return candidates.sort((a, b) =>
    Number(b.rawProbability ?? b.probability) - Number(a.rawProbability ?? a.probability)
    || (football ? Number(b.odd || 0) - Number(a.odd || 0) : Number(b.reliability) - Number(a.reliability))
  ).map(selection => {
    const game = gamesById.get(String(selection.fixtureId));
    const liveResult = football ? liveStats[selection.fixtureId] : game.liveResult;
    return {
      id: selection.id,
      fixtureId: selection.fixtureId,
      matchName: `${game.teams?.home?.name || ''} vs ${game.teams?.away?.name || ''}`,
      name: selection.name,
      cat: selection.cat,
      probability: selection.probability,
      rawProbability: selection.rawProbability ?? selection.probability,
      reliability: selection.reliability,
      odd: selection.odd,
      bookmaker: selection.bookmaker,
      resultState: marketResultState({ sport, game, liveResult }),
      outcome: settleMarketSelection({ sport, selection, game, liveResult }),
    };
  });
}
