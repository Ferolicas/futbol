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
      n[fixtureId] = { ...(n[fixtureId] || {}) };
      if (n[fixtureId][market.id]) {
        delete n[fixtureId][market.id];
        if (Object.keys(n[fixtureId]).length === 0) delete n[fixtureId];
      } else {
        n[fixtureId][market.id] = { ...market, matchName };
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
