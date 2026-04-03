'use client';

import { createContext, useCallback, useContext, useState } from 'react';
import { usePusherEvent } from '../../lib/use-pusher';

const LiveStatsContext = createContext({
  liveStats: {},
  setLiveStats: () => {},
  isPopulated: false,
});

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
        next[fid] = {
          ...existing,
          fixtureId: fid,
          status: m.status,
          goals: m.goals,
          score: m.score,
          elapsed: m.status?.elapsed,
          corners: m.corners?.total > 0 ? m.corners : (existing.corners || m.corners),
          yellowCards: m.yellowCards?.total > 0 ? m.yellowCards : (existing.yellowCards || m.yellowCards),
          redCards: m.redCards?.total > 0 ? m.redCards : (existing.redCards || m.redCards),
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

  return (
    <LiveStatsContext.Provider value={{ liveStats, setLiveStats, isPopulated }}>
      {children}
    </LiveStatsContext.Provider>
  );
}
