import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export interface SelectedMarket {
  id: string;
  name: string;
  probability?: number;
  rawProbability?: number;
  odd?: number | null;
  bookmaker?: string | null;
  matchName: string;
  [key: string]: unknown;
}

export type SelectedMarkets = Record<string, Record<string, SelectedMarket>>;

interface Ctx {
  selectedMarkets: SelectedMarkets;
  toggleMarket: (fixtureId: string | number, market: any, matchName: string) => void;
  removeMarket: (fixtureId: string | number, marketId: string) => void;
  clearMarkets: () => void;
  totalSelections: number;
}

const SelectedMarketsContext = createContext<Ctx>({
  selectedMarkets: {}, toggleMarket: () => {}, removeMarket: () => {}, clearMarkets: () => {}, totalSelections: 0,
});

export const useSelectedMarkets = () => useContext(SelectedMarketsContext);

// Un único mercado por partido: sin cuota Bet Builder oficial no se pueden
// multiplicar dos mercados del mismo encuentro como independientes.
export function SelectedMarketsProvider({ children }: { children: ReactNode }) {
  const [selectedMarkets, setSelectedMarkets] = useState<SelectedMarkets>({});

  const toggleMarket = useCallback((fixtureId: string | number, market: any, matchName: string) => {
    const key = String(fixtureId);
    setSelectedMarkets((prev) => {
      const next = { ...prev };
      if (next[key]?.[market.id]) delete next[key];
      else next[key] = { [market.id]: { ...market, matchName } };
      return next;
    });
  }, []);

  const removeMarket = useCallback((fixtureId: string | number, marketId: string) => {
    const key = String(fixtureId);
    setSelectedMarkets((prev) => {
      const entries = { ...(prev[key] || {}) };
      delete entries[marketId];
      const next = { ...prev };
      if (Object.keys(entries).length) next[key] = entries; else delete next[key];
      return next;
    });
  }, []);

  const clearMarkets = useCallback(() => setSelectedMarkets({}), []);
  const totalSelections = useMemo(() => Object.values(selectedMarkets).reduce((sum, item) => sum + Object.keys(item).length, 0), [selectedMarkets]);

  const value = useMemo(() => ({ selectedMarkets, toggleMarket, removeMarket, clearMarkets, totalSelections }), [selectedMarkets, toggleMarket, removeMarket, clearMarkets, totalSelections]);
  return <SelectedMarketsContext.Provider value={value}>{children}</SelectedMarketsContext.Provider>;
}
