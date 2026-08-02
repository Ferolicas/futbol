'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { usePusherEvent } from '../../lib/use-pusher';

const LiveStatsContext = createContext({
  liveStats: {},
  setLiveStats: () => {},
  isPopulated: false,
});

const isCoveredCounter = (counter) => counter?.isReal === true || Number(counter?.total || 0) > 0;
const LIVE = new Set(['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE']);
const FINISHED = new Set(['FT', 'AET', 'PEN']);
const PENDING = new Set(['NS', 'TBD']);

function rejectsStatusRegression(current, incoming) {
  if (!current || !incoming || current === incoming) return false;
  if (FINISHED.has(current) && !FINISHED.has(incoming)) return true;
  return LIVE.has(current) && PENDING.has(incoming);
}

export function useLiveStats() {
  return useContext(LiveStatsContext);
}

export default function LiveStatsProvider({ children }) {
  const [liveStats, setLiveStats] = useState({});
  const isPopulated = Object.keys(liveStats).length > 0;

  // Live scores: all match stats updated in real-time — single subscription for the whole dashboard tree
  usePusherEvent('live-scores', 'update', useCallback((data) => {
    if (!data?.matches) return;
    setLiveStats(prev => {
      const next = { ...prev };
      data.matches.forEach(m => {
        const fid = m.fixtureId;
        const existing = next[fid] || {};
        const keepObservedState = rejectsStatusRegression(existing.status?.short, m.status?.short);
        next[fid] = {
          ...existing,
          fixtureId: fid,
          status: keepObservedState ? existing.status : (m.status || existing.status),
          goals: keepObservedState ? existing.goals : (m.goals || existing.goals),
          score: keepObservedState ? existing.score : (m.score || existing.score),
          elapsed: keepObservedState ? existing.elapsed : (m.status?.elapsed ?? existing.elapsed),
          corners: isCoveredCounter(m.corners) ? m.corners : (existing.corners || m.corners),
          yellowCards: isCoveredCounter(m.yellowCards) ? m.yellowCards : (existing.yellowCards || m.yellowCards),
          redCards: isCoveredCounter(m.redCards) ? m.redCards : (existing.redCards || m.redCards),
          goalScorers: m.goalScorers?.length > 0 ? m.goalScorers : (existing.goalScorers || []),
          missedPenalties: m.missedPenalties?.length > 0 ? m.missedPenalties : (existing.missedPenalties || []),
        };
      });
      return next;
    });
  }, []));

  // Corners update (dedicated cron, runs every ~45 min)
  usePusherEvent('live-scores', 'corners-update', useCallback((data) => {
    if (!data?.matches) return;
    setLiveStats(prev => {
      const next = { ...prev };
      data.matches.forEach(m => {
        const fid = m.fixtureId;
        if (next[fid]) next[fid] = { ...next[fid], corners: m.corners };
      });
      return next;
    });
  }, []));

  // RT-3: memoizar el value para no recrear el objeto en cada render → evita
  // re-render en cascada de todos los consumidores cuando nada cambió.
  // (setLiveStats es estable entre renders, no hace falta como dependencia.)
  const value = useMemo(() => ({ liveStats, setLiveStats, isPopulated }), [liveStats, isPopulated]);

  return (
    <LiveStatsContext.Provider value={value}>
      {children}
    </LiveStatsContext.Provider>
  );
}
