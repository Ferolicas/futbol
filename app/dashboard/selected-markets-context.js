'use client';

import { createContext, useContext, useState } from 'react';

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

  const toggleMarket = (fixtureId, market, matchName) => {
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
  };

  return (
    <SelectedMarketsContext.Provider value={{ selectedMarkets, toggleMarket, setSelectedMarkets }}>
      {children}
    </SelectedMarketsContext.Provider>
  );
}
