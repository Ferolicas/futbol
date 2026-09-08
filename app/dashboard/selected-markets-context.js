'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

const SelectedMarketsContext = createContext({
  selectedMarkets: {},
  toggleMarket: () => {},
  setSelectedMarkets: () => {},
});

export function useSelectedMarkets() {
  return useContext(SelectedMarketsContext);
}

export default function SelectedMarketsProvider({ children }) {
  const [selectedMarkets, setSelectedMarkets] = useState({});

  const toggleMarket = useCallback((fixtureId, market, matchName) => {
    setSelectedMarkets(prev => {
      const n = { ...prev };
      const wasSelected = !!n[fixtureId]?.[market.id];
      if (wasSelected) {
        delete n[fixtureId];
      } else {
        // Sin una cuota Bet Builder oficial no se pueden multiplicar dos
        // mercados del mismo partido como si fueran independientes. Elegir
        // otra línea del fixture sustituye la anterior.
        n[fixtureId] = { [market.id]: { ...market, matchName } };
      }
      return n;
    });
  }, []);

  const value = useMemo(
    () => ({ selectedMarkets, toggleMarket, setSelectedMarkets }),
    [selectedMarkets, toggleMarket],
  );

  return (
    <SelectedMarketsContext.Provider value={value}>
      {children}
    </SelectedMarketsContext.Provider>
  );
}
