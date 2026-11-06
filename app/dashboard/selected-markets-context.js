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
      // Se pueden marcar varias opciones del mismo partido, como en «Crear
      // apuesta». Lo que no se hace es multiplicar sus cuotas: la combinada
      // deja la cuota total sin precio y la pide a la casa.
      const fixtureMarkets = { ...(n[fixtureId] || {}) };
      if (fixtureMarkets[market.id]) delete fixtureMarkets[market.id];
      else fixtureMarkets[market.id] = { ...market, matchName };
      if (Object.keys(fixtureMarkets).length) n[fixtureId] = fixtureMarkets;
      else delete n[fixtureId];
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
