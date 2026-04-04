'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../components/providers';
import { motion, AnimatePresence } from 'framer-motion';
import { FLAGS } from '../../lib/leagues';
import { usePusherEvent } from '../../lib/use-pusher';
import { selectBookmakerOdds, BOOKMAKER_LOGOS, TIMEZONE_TO_COUNTRY } from '../../lib/bookmakers';
import { todayInTz, getUserTz, fmtTimeInTz, fmtDateDisplay } from '../../lib/timezone';
import { useLiveStats } from './live-stats-context';
import { useSelectedMarkets } from './selected-markets-context';

function detectCountry() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TIMEZONE_TO_COUNTRY[tz] || 'default';
  } catch { return 'default'; }
}

// Uses the user's local timezone — never UTC (fixes LATAM "shows next day" bug)
const today = (tz) => todayInTz(tz || getUserTz());
const fmtTime = (d, tz) => fmtTimeInTz(d, tz || getUserTz());
const isLive = (s) => ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'].includes(s);
const isFinished = (s) => ['FT', 'AET', 'PEN', 'AWD', 'WO'].includes(s);
const isPostponed = (s) => ['PST', 'CANC', 'SUSP', 'ABD'].includes(s);
const statusText = (s) => ({
  NS: 'Proximo', '1H': '1T', '2H': '2T', HT: 'Entretiempo',
  FT: 'Final', ET: 'Extra', P: 'Penales', AET: 'Extra', PEN: 'Penales',
  SUSP: 'Suspendido', PST: 'Pospuesto', CANC: 'Cancelado',
}[s] || s);

// Display cap: internally probabilities can be 100%, but we show max 95% to the user
const cap = (v) => Math.min(95, v);

// Module-level cache — survives component remounts during SPA navigation
// (e.g., going to match detail and back). Reset only on full page reload.
let _dashCache = null;
let _splashDone = false;

export default function Dashboard() {
  const router = useRouter();
  const { user, supabase } = useAuth();
  const [splash, setSplash] = useState(!_splashDone);
  const [splashFade, setSplashFade] = useState(false);
  const [userTz, setUserTz] = useState('UTC'); // corrected on mount to user's real timezone
  const [tab, setTab] = useState('partidos');
  const [date, setDate] = useState(today());
  const [fixtures, setFixtures] = useState(_dashCache?.fixtures || []);
  const [loading, setLoading] = useState(!_dashCache);
  const [error, setError] = useState('');
  const [fromCache, setFromCache] = useState(_dashCache?.fromCache || false);
  const [quota, setQuota] = useState(_dashCache?.quota || { used: 0 });
  const [hidden, setHidden] = useState(_dashCache?.hidden || []);
  const [favorites, setFavorites] = useState(_dashCache?.favorites || []);
  const [analyzed, setAnalyzed] = useState(_dashCache?.analyzed || []);
  const [analyzedOdds, setAnalyzedOdds] = useState(_dashCache?.analyzedOdds || {});
  const [analyzedData, setAnalyzedData] = useState(_dashCache?.analyzedData || {});
  const [standings, setStandings] = useState(_dashCache?.standings || {});
  const [sortBy, setSortBy] = useState('time');
  const [statusFilter, setStatusFilter] = useState('all');
  const [leagueFilter, setLeagueFilter] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [analyzing, setAnalyzing] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  // Accordion for Analizados
  const [expandedMatch, setExpandedMatch] = useState(null);
  // Custom combinada: shared via context so analisis/[id] page can add to it
  const { selectedMarkets, toggleMarket, setSelectedMarkets } = useSelectedMarkets();
  const [showApuesta, setShowApuesta] = useState(true);
  // Multiple saved combinadas
  const [savedCombinadas, setSavedCombinadas] = useState([]);
  const [savingComb, setSavingComb] = useState(false);
  // Live match stats — shared context: dashboard + detail page use the same data
  const { liveStats, setLiveStats, isPopulated } = useLiveStats();
  // Owner re-analyze state
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalyzeDone, setReanalyzeDone] = useState(false);
  const [reanalyzeProgress, setReanalyzeProgress] = useState(null);
  // Track Pusher activity (for debugging/diagnostics)
  const pusherLastUpdate = useRef(0);
  // Web push notifications
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSupported, setPushSupported] = useState(false);

  // Seed context from navigation cache when layout remounts (e.g. user navigated outside /dashboard and back)
  useEffect(() => {
    if (!isPopulated && _dashCache?.liveStats && Object.keys(_dashCache.liveStats).length > 0) {
      setLiveStats(prev => ({ ...prev, ..._dashCache.liveStats }));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync context back to navigation cache so back-navigation is instant
  useEffect(() => {
    if (_dashCache) _dashCache.liveStats = liveStats;
  }, [liveStats]);

  // Apply live data to fixtures — NEVER downgrade a finished match or go backwards in time
  const applyLiveUpdate = useCallback((prev, freshMatches) => {
    const FT = ['FT', 'AET', 'PEN'];
    const updated = prev.map(f => {
      const fresh = freshMatches.find(m =>
        (m.fixtureId || m.fixture?.id) === f.fixture.id
      );
      if (!fresh) return f;

      // NEVER downgrade a finished match — FT is final
      if (FT.includes(f.fixture.status.short)) return f;

      const freshStatus = fresh.status || fresh.fixture?.status;
      const freshElapsed = freshStatus?.elapsed ?? fresh.elapsed;
      const currentElapsed = f.fixture.status.elapsed;

      // Never go backwards in elapsed time
      if (currentElapsed && freshElapsed && freshElapsed < currentElapsed &&
          !FT.includes(freshStatus?.short)) {
        return f;
      }

      return {
        ...f,
        fixture: {
          ...f.fixture,
          status: freshStatus || f.fixture.status,
        },
        goals: fresh.goals || f.goals,
        score: fresh.score || f.score,
      };
    });
    if (_dashCache) _dashCache.fixtures = updated;
    return updated;
  }, []);

  const isOwner = user?.email?.toLowerCase() === 'ferneyolicas@gmail.com';

  const handleReanalyze = async () => {
    setReanalyzing(true);
    setReanalyzeDone(false);
    setReanalyzeProgress(null);
    try {
      const res = await fetch(`/api/admin/reanalyze?date=${date}&force=true`, { method: 'POST' });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'progress' || data.type === 'start') {
              setReanalyzeProgress(data);
            }
            if (data.type === 'done') {
              setReanalyzeProgress(data);
              setReanalyzeDone(true);
              setTimeout(() => { setReanalyzeDone(false); setReanalyzeProgress(null); }, 4000);
              loadFixtures(date);
            }
          } catch {}
        }
      }
    } catch (e) {
      console.error('[REANALYZE]', e);
    } finally {
      setReanalyzing(false);
    }
  };

  // Fetch missing stats for finished matches immediately (don't wait for cron).
  // Called on page load and after reanalyze — uses Redis cache, API only when truly missing.
  const refreshFinishedStats = useCallback(async (currentFixtures, currentLiveStats) => {
    const FINISHED = ['FT', 'AET', 'PEN'];
    const missing = (currentFixtures || []).filter(f => {
      if (!FINISHED.includes(f.fixture?.status?.short)) return false;
      const s = currentLiveStats[f.fixture.id];
      return !s || (!s.corners && !s.yellowCards && !s.goalScorers?.length && !s.cardEvents?.length);
    });
    if (missing.length === 0) return;

    const results = await Promise.allSettled(
      missing.map(f =>
        fetch(`/api/match/${f.fixture.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'refresh-stats' }),
        }).then(r => r.json())
      )
    );

    const updates = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value?.stats) {
        const fid = missing[i].fixture.id;
        const stats = r.value.stats;
        const existing = currentLiveStats[fid];
        // Merge: take corners/cards/scorers but preserve FT status/goals
        updates[fid] = {
          ...(existing || {}),
          corners: stats.corners || existing?.corners,
          yellowCards: stats.yellowCards || existing?.yellowCards,
          redCards: stats.redCards || existing?.redCards,
          goalScorers: stats.goalScorers?.length > 0 ? stats.goalScorers : (existing?.goalScorers || []),
          cardEvents: stats.cardEvents?.length > 0 ? stats.cardEvents : (existing?.cardEvents || []),
          missedPenalties: stats.missedPenalties?.length > 0 ? stats.missedPenalties : (existing?.missedPenalties || []),
          // Always keep the fixture's FT status, never overwrite with stale live status
          status: existing?.status || missing[i].fixture.status,
          goals: existing?.goals || missing[i].goals,
        };
      }
    });
    if (Object.keys(updates).length > 0) {
      setLiveStats(prev => ({ ...prev, ...updates }));
    }
  }, [setLiveStats]);

  const loadFixtures = useCallback(async (d, { silent, tz, clearLiveStats } = {}) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const tzParam = tz || getUserTz();
      const res = await fetch(`/api/fixtures?date=${d}&tz=${encodeURIComponent(tzParam)}`);
      const data = await res.json();
      if (data.error && !data.fixtures?.length) {
        setError(data.error);
        if (data.quota) setQuota(data.quota);
        return;
      }
      const fx = data.fixtures || [];
      setFixtures(fx);
      setFromCache(data.fromCache || false);
      setHidden(data.hidden || []);
      setFavorites(data.favorites || []);
      setAnalyzed(data.analyzed || []);
      setAnalyzedOdds(data.analyzedOdds || {});
      setAnalyzedData(data.analyzedData || {});
      setStandings(data.standings || {});
      if (data.quota) setQuota(data.quota);
      if (data.error) setError(data.error);
      // Track if daily analysis batch is still running (timeout after 10 min)
      const batchAge = data.batchStatus?.startedAt
        ? Date.now() - new Date(data.batchStatus.startedAt).getTime() : 0;
      if (data.batchStatus?.started && !data.batchStatus?.completed && batchAge < 600000) {
        setBatchRunning(true);
      } else {
        setBatchRunning(false);
      }

      // Populate initial live stats from /api/fixtures response (corners, cards, scorers)
      if (data.initialLiveStats && Object.keys(data.initialLiveStats).length > 0) {
        if (clearLiveStats) {
          // Date change: replace entirely with server data (old date data is irrelevant)
          setLiveStats(data.initialLiveStats);
        } else {
          // Same date refresh: merge carefully, never downgrade FT stats
          const FT = ['FT', 'AET', 'PEN'];
          setLiveStats(prev => {
            const next = { ...prev };
            for (const [fid, fresh] of Object.entries(data.initialLiveStats)) {
              const existing = next[fid];
              if (existing && FT.includes(existing.status?.short)) {
                next[fid] = {
                  ...existing,
                  corners: fresh.corners?.total > 0 ? fresh.corners : existing.corners,
                  yellowCards: fresh.yellowCards?.total > 0 ? fresh.yellowCards : existing.yellowCards,
                  redCards: fresh.redCards || existing.redCards,
                  goalScorers: fresh.goalScorers?.length > 0 ? fresh.goalScorers : existing.goalScorers,
                  cardEvents: fresh.cardEvents?.length > 0 ? fresh.cardEvents : existing.cardEvents,
                  missedPenalties: fresh.missedPenalties?.length > 0 ? fresh.missedPenalties : existing.missedPenalties,
                };
              } else {
                next[fid] = fresh;
              }
            }
            return next;
          });
        }
      } else if (clearLiveStats) {
        setLiveStats({});
      }

      // Background: fetch missing stats for finished matches (only if truly missing)
      refreshFinishedStats(fx, data.initialLiveStats || {});

      // Persist to module cache for instant back-navigation
      _dashCache = {
        fixtures: fx, analyzed: data.analyzed || [], analyzedOdds: data.analyzedOdds || {},
        analyzedData: data.analyzedData || {}, standings: data.standings || {},
        hidden: data.hidden || [], favorites: data.favorites || [],
        fromCache: data.fromCache || false,
        quota: data.quota || { used: 0 },
        liveStats: data.initialLiveStats || {},
      };
    } catch (e) {
      setError(e.message || 'Error de conexion');
    } finally {
      setLoading(false);
    }
  }, [refreshFinishedStats]);

  // Force-refresh live data: triggers live + corners crons on the server,
  // then updates all live stats (scores, corners, cards, goal scorers, minutes).
  const [refreshingLive, setRefreshingLive] = useState(false);

  const refreshLiveData = useCallback(async (overrideDate) => {
    const sentDate = overrideDate || date;
    console.log('[REFRESH] 🔄 llamando /api/refresh-live con date:', sentDate);
    setRefreshingLive(true);
    try {
      const res = await fetch('/api/refresh-live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: sentDate }),
      });
      const data = await res.json();
      console.log('[REFRESH] ✅ respuesta del servidor:', {
        success: data.success,
        skipped: data.skipped,
        reason: data.reason,
        liveCount: data.liveCount,
        staleFixed: data.staleFixed,
        viewDateStaleFixed: data.viewDateStaleFixed,
        apiCalls: data.apiCalls,
        hasLiveStats: !!data.liveStats && Object.keys(data.liveStats).length,
        hasViewDateLiveStats: !!data.viewDateLiveStats && Object.keys(data.viewDateLiveStats || {}).length,
        viewDateLiveStatsSample: data.viewDateLiveStats
          ? Object.entries(data.viewDateLiveStats).slice(0, 5).map(([fid, s]) => `${fid}:${s.status?.short}`)
          : null,
        liveStatsSample: data.liveStats
          ? Object.entries(data.liveStats).slice(0, 5).map(([fid, s]) => `${fid}:${s.status?.short}`)
          : null,
      });
      const FT = ['FT', 'AET', 'PEN'];

      // Helper: merge live stats into state
      const mergeLiveStats = (statsObj, label) => {
        if (!statsObj || typeof statsObj !== 'object') return;
        const ftEntries = Object.entries(statsObj).filter(([, s]) => FT.includes(s.status?.short));
        const liveEntries = Object.entries(statsObj).filter(([, s]) => !FT.includes(s.status?.short) && s.status?.short);
        console.log(`[REFRESH] merge ${label}: total=${Object.keys(statsObj).length} FT=${ftEntries.length} live=${liveEntries.length}`,
          ftEntries.slice(0, 5).map(([fid, s]) => `${fid}:${s.status?.short}`),
          liveEntries.slice(0, 5).map(([fid, s]) => `${fid}:${s.status?.short}`)
        );
        setLiveStats(prev => {
          const next = { ...prev };
          for (const [fid, fresh] of Object.entries(statsObj)) {
            const existing = next[fid];
            if (existing?.status?.short !== fresh.status?.short) {
              console.log(`[REFRESH] estado cambió fid=${fid}: ${existing?.status?.short} → ${fresh.status?.short}`);
            }
            // If server says FT, always accept — this fixes stale "live" entries
            if (FT.includes(fresh.status?.short)) {
              next[fid] = {
                ...(existing || {}),
                ...fresh,
                corners: fresh.corners?.total > 0 ? fresh.corners : (existing?.corners || fresh.corners),
                goalScorers: fresh.goalScorers?.length > 0 ? fresh.goalScorers : (existing?.goalScorers || []),
                cardEvents: fresh.cardEvents?.length > 0 ? fresh.cardEvents : (existing?.cardEvents || []),
                missedPenalties: fresh.missedPenalties?.length > 0 ? fresh.missedPenalties : (existing?.missedPenalties || []),
              };
            } else if (existing && FT.includes(existing.status?.short)) {
              // Existing is FT — only upgrade stats, never downgrade status
              next[fid] = {
                ...existing,
                corners: fresh.corners?.total > 0 ? fresh.corners : existing.corners,
                yellowCards: fresh.yellowCards?.total > 0 ? fresh.yellowCards : existing.yellowCards,
                redCards: fresh.redCards || existing.redCards,
                goalScorers: fresh.goalScorers?.length > 0 ? fresh.goalScorers : existing.goalScorers,
                cardEvents: fresh.cardEvents?.length > 0 ? fresh.cardEvents : existing.cardEvents,
                missedPenalties: fresh.missedPenalties?.length > 0 ? fresh.missedPenalties : existing.missedPenalties,
              };
            } else {
              next[fid] = {
                ...(existing || {}),
                ...fresh,
                corners: fresh.corners?.total > 0 ? fresh.corners : (existing?.corners || fresh.corners),
                goalScorers: fresh.goalScorers?.length > 0 ? fresh.goalScorers : (existing?.goalScorers || []),
                missedPenalties: fresh.missedPenalties?.length > 0 ? fresh.missedPenalties : (existing?.missedPenalties || []),
              };
            }
          }
          return next;
        });
        setFixtures(prev => applyLiveUpdate(prev, Object.values(statsObj)));
      };

      // Merge today's live stats
      if (data.liveStats && typeof data.liveStats === 'object') {
        mergeLiveStats(data.liveStats, 'liveStats(today)');
      }
      // Merge viewed date live stats (fixes stale entries from past dates)
      if (data.viewDateLiveStats && typeof data.viewDateLiveStats === 'object') {
        mergeLiveStats(data.viewDateLiveStats, 'viewDateLiveStats');
      }
    } catch (err) {
      console.error('[REFRESH] ❌ error:', err);
    } finally {
      setRefreshingLive(false);
    }
  }, [date, applyLiveUpdate]);

  // On mount: detect user timezone, correct date to local, refresh live first, then load fixtures
  useEffect(() => {
    const tz = getUserTz();
    setUserTz(tz);
    const localDate = todayInTz(tz);
    setDate(localDate);
    // Sequential: refresh live data (fixes stale statuses in Redis) before loading fixtures
    refreshLiveData(localDate).finally(() => {
      loadFixtures(localDate, { silent: !!_dashCache, tz });
    });
  }, [loadFixtures, refreshLiveData]);

  // Live polling fallback (30s) when there are live matches — supplements Pusher
  useEffect(() => {
    const hasLive = fixtures.some(f => isLive(f.fixture.status.short));
    if (!hasLive) return;
    const poll = setInterval(refreshLiveData, 30000);
    return () => clearInterval(poll);
  }, [fixtures, refreshLiveData]);

  // Load saved combinadas per-user on mount
  useEffect(() => {
    fetch('/api/user?type=combinadas')
      .then(r => r.json())
      .then(data => {
        if (data.combinadas?.length) {
          setSavedCombinadas(data.combinadas.map(c => ({
            ...c,
            id: c._id || c.id || Date.now(),
          })));
        }
      })
      .catch(() => {});
  }, []);

  // Track loading via ref so splash effect can read latest value
  const loadingRef = useRef(loading);
  useEffect(() => { loadingRef.current = loading; }, [loading]);

  // Splash screen: show briefly on FIRST visit only, fade out as soon as data loads
  useEffect(() => {
    if (_splashDone) { setSplash(false); return; }
    const minTime = new Promise(r => setTimeout(r, 800));
    const dataReady = new Promise(r => {
      const check = () => !loadingRef.current ? r() : setTimeout(check, 50);
      check();
    });
    Promise.all([minTime, dataReady]).then(() => {
      _splashDone = true;
      setSplashFade(true);
      setTimeout(() => setSplash(false), 400);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // === WEB PUSH NOTIFICATIONS ===
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    setPushSupported(true);
    navigator.serviceWorker.register('/sw.js').then(reg => {
      reg.pushManager.getSubscription().then(sub => setPushEnabled(!!sub));
    }).catch(() => {});
  }, []);

  // Subscribe to push notifications (reusable — called by bell toggle AND auto on favorite)
  const subscribePush = useCallback(async () => {
    if (!pushSupported) return false;
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) { setPushEnabled(true); return true; } // already subscribed
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return false;
      const vapidKey = process.env.NEXT_PUBLIC_VAPID_KEY;
      if (!vapidKey) return false;
      const padding = '='.repeat((4 - vapidKey.length % 4) % 4);
      const base64 = (vapidKey + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = window.atob(base64);
      const appServerKey = new Uint8Array([...raw].map(c => c.charCodeAt(0)));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub),
      });
      setPushEnabled(true);
      return true;
    } catch (e) {
      console.error('[PUSH]', e);
      return false;
    }
  }, [pushSupported]);

  const handlePushToggle = async () => {
    if (!pushSupported) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await existing.unsubscribe();
        await fetch('/api/push/subscribe', { method: 'DELETE' });
        setPushEnabled(false);
      } else {
        await subscribePush();
      }
    } catch (e) {
      console.error('[PUSH]', e);
    }
  };

  // === PUSHER REAL-TIME EVENTS ===
  // Only subscribe to Pusher for today's date — past dates are historical/fixed
  const isViewingToday = date === todayInTz(userTz);

  // Live scores: update fixture list in real-time (liveStats handled by LiveStatsProvider)
  usePusherEvent(isViewingToday ? 'live-scores' : null, 'update', useCallback((data) => {
    if (!data?.matches) return;
    pusherLastUpdate.current = Date.now();
    setFixtures(prev => applyLiveUpdate(prev, data.matches));
  }, [applyLiveUpdate]));

  // Lineups: notify that lineups are available (only for today)
  usePusherEvent(isViewingToday ? 'match-updates' : null, 'lineups-ready', useCallback((data) => {
    if (!data?.fixtureIds) return;
    // Reload fixtures to get updated analysis with lineups
    loadFixtures(date);
  }, [date, loadFixtures]));

  // Odds update from The Odds API cron
  usePusherEvent(isViewingToday ? 'live-scores' : null, 'odds-update', useCallback((data) => {
    if (!data?.odds) return;
    // Merge fresh odds into analyzed data
    setAnalyzedOdds(prev => {
      const next = { ...prev };
      for (const [fid, odds] of Object.entries(data.odds)) {
        if (odds.matchWinner) {
          next[fid] = {
            ...(next[fid] || {}),
            home: odds.matchWinner.home,
            draw: odds.matchWinner.draw,
            away: odds.matchWinner.away,
          };
        }
      }
      return next;
    });
  }, []));

  // corners-update handled by LiveStatsProvider

  // Analysis batch: reload when complete (via Pusher, only for today)
  usePusherEvent(isViewingToday ? 'analysis' : null, 'batch-complete', useCallback((data) => {
    if (data?.date === date) {
      setBatchRunning(false);
      loadFixtures(date);
    }
  }, [date, loadFixtures]));

  // Polling fallback: if batch is running, poll every 20s until it completes
  useEffect(() => {
    if (!batchRunning) return;
    const pollBatch = setInterval(() => {
      loadFixtures(date);
    }, 20000);
    return () => clearInterval(pollBatch);
  }, [batchRunning, date, loadFixtures]);

  // Live updates come exclusively from Pusher (cron/live pushes every minute).
  // No more client-side polling — saves API quota and reduces latency.

  const changeDate = (offset) => {
    // Parse components directly to avoid UTC-vs-local timezone shift:
    // new Date("2025-03-25") parses as UTC midnight, so getDate() returns the
    // LOCAL day which is 1 behind in UTC+X and causes the stuck/double-jump bug.
    const [y, m, day] = date.split('-').map(Number);
    const d = new Date(y, m - 1, day + offset); // local constructor, no UTC offset
    const nd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    setDate(nd);
    setSelected(new Set());
    setSelectedMarkets({});
    setExpandedMatch(null);
    // Don't clear liveStats here — loadFixtures will replace them atomically
    // to avoid flickering (empty → loaded). loadFixtures sets fresh stats from server.
    pusherLastUpdate.current = 0;
    loadFixtures(nd, { tz: userTz, clearLiveStats: true });
  };

  const visible = fixtures.filter(f => {
    if (hidden.includes(f.fixture.id)) return false;
    const status = f.fixture.status.short;
    // Hide postponed/cancelled/suspended/abandoned matches
    if (isPostponed(status)) return false;
    if (statusFilter === 'live' && !isLive(status)) return false;
    if (statusFilter === 'upcoming' && status !== 'NS') return false;
    if (statusFilter === 'finished' && !isFinished(status)) return false;
    if (statusFilter === 'favoritos' && !favorites.includes(f.fixture.id)) return false;
    if (leagueFilter && String(f.league.id) !== leagueFilter) return false;
    return true;
  });

  const sorted = [...visible].sort((a, b) => {
    if (sortBy === 'time') return new Date(a.fixture.date) - new Date(b.fixture.date);
    if (sortBy === 'odds') {
      const oddA = getMinOdd(a, analyzedOdds), oddB = getMinOdd(b, analyzedOdds);
      if (oddA === 0 && oddB === 0) return new Date(a.fixture.date) - new Date(b.fixture.date);
      if (oddA === 0) return 1;
      if (oddB === 0) return -1;
      return oddA - oddB;
    }
    if (sortBy === 'probability') {
      const aA = analyzed.includes(a.fixture.id) ? 1 : 0;
      const bA = analyzed.includes(b.fixture.id) ? 1 : 0;
      if (aA !== bA) return bA - aA;
      const aP = analyzedData[a.fixture.id]?.combinada?.combinedProbability || 0;
      const bP = analyzedData[b.fixture.id]?.combinada?.combinedProbability || 0;
      if (aP !== bP) return bP - aP;
      return new Date(a.fixture.date) - new Date(b.fixture.date);
    }
    return 0;
  });

  const toggleSelect = (fid) => {
    setSelected(prev => {
      const n = new Set(prev);
      n.has(fid) ? n.delete(fid) : n.add(fid);
      return n;
    });
  };


  const analyzeSelected = async () => {
    const toAnalyze = fixtures.filter(f => selected.has(f.fixture.id));
    if (toAnalyze.length === 0) return;
    setAnalyzing(true);
    try {
      const res = await fetch('/api/analisis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtures: toAnalyze, date }),
      });
      const data = await res.json();
      if (data.quota) setQuota(data.quota);
      const newAnalyzed = data.analyses?.filter(a => a.success)?.map(a => a.fixtureId) || [];
      setAnalyzed(prev => [...new Set([...prev, ...newAnalyzed])]);
      setSelected(new Set());
      loadFixtures(date);
      if (newAnalyzed.length > 0) setTab('analizados');
    } catch (e) {
      setError('Error al analizar: ' + e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  // Unified dismiss: removes from both Partidos AND Analizados tabs
  const dismissMatch = async (e, fixtureId) => {
    e.stopPropagation();
    setHidden(prev => {
      const next = prev.includes(fixtureId) ? prev : [...prev, fixtureId];
      if (_dashCache) _dashCache.hidden = next; // keep SPA back-navigation in sync
      return next;
    });
    setAnalyzed(prev => prev.filter(id => id !== fixtureId));
    setSelectedMarkets(prev => {
      const n = { ...prev };
      delete n[fixtureId];
      return n;
    });
    // Persist: hide from Partidos + remove from Analizados
    try {
      await fetch('/api/hidden', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId, date }),
      });
    } catch (e) {
      console.error('[dismissMatch]', e.message);
    }
  };

  // Toggle favorite — optimistic update + Supabase persist
  // When ADDING a favorite, auto-enable push notifications so goals always arrive
  const toggleFavorite = async (e, fixtureId) => {
    e.stopPropagation();
    const isFav = favorites.includes(fixtureId);
    setFavorites(prev => isFav ? prev.filter(id => id !== fixtureId) : [...prev, fixtureId]);
    if (_dashCache) _dashCache.favorites = isFav
      ? (_dashCache.favorites || []).filter(id => id !== fixtureId)
      : [...(_dashCache.favorites || []), fixtureId];
    try {
      await fetch('/api/favorites', {
        method: isFav ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId }),
      });
      // Auto-subscribe to push when adding a favorite (not removing)
      if (!isFav && !pushEnabled && pushSupported) {
        subscribePush();
      }
    } catch (e) {
      console.error('[toggleFavorite]', e.message);
    }
  };

  // Keep backward-compatible aliases
  const doHide = dismissMatch;
  const removeFromAnalyzed = dismissMatch;

  // Save current combinada
  const saveCombinada = async () => {
    if (!customCombinada || customCombinada.selections.length === 0) return;
    setSavingComb(true);
    try {
      const name = `Combinada ${savedCombinadas.length + 1} - ${new Date().toLocaleDateString('es')}`;
      setSavedCombinadas(prev => [...prev, { name, ...customCombinada, id: Date.now() }]);
      // Save to backend if user is logged in
      await fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'save-combinada', data: { name, ...customCombinada } }),
      }).catch(() => {});
    } finally {
      setSavingComb(false);
    }
  };

  const deleteSavedCombinada = async (combId) => {
    setSavedCombinadas(prev => prev.filter(c => c.id !== combId));
    // Persist deletion per-user
    try {
      await fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'delete-combinada', data: { combinadaId: String(combId) } }),
      });
    } catch {}
  };

  const liveCount = fixtures.filter(f => !hidden.includes(f.fixture.id) && isLive(f.fixture.status.short)).length;
  const upcomingCount = fixtures.filter(f => !hidden.includes(f.fixture.id) && f.fixture.status.short === 'NS').length;
  const favoriteCount = favorites.length;

  const leagues = {};
  fixtures.filter(f => !hidden.includes(f.fixture.id)).forEach(f => {
    if (!leagues[f.league.id]) {
      leagues[f.league.id] = { id: f.league.id, name: f.league.name, country: f.leagueMeta?.country || f.league.country };
    }
  });

  const apuestaDelDia = useMemo(() => {
    const now = new Date();
    const allBets = [];
    Object.entries(analyzedData).forEach(([fid, data]) => {
      if (!data?.combinada?.selections) return;
      const fx = fixtures.find(f => f.fixture.id === Number(fid));
      const status = fx?.fixture?.status?.short;
      const matchTime = fx ? new Date(fx.fixture.date) : null;
      // Priority: upcoming > live > finished (prefer matches not yet played)
      let priority = 0;
      if (status === 'NS') priority = 2;
      else if (isLive(status)) priority = 1;
      else if (isFinished(status)) priority = 0;
      const mn = fx ? `${fx.teams.home.name} vs ${fx.teams.away.name}` : `${data.homeTeam || '?'} vs ${data.awayTeam || '?'}`;
      const homeTeam = fx?.teams?.home?.name || data.homeTeam || '';
      const awayTeam = fx?.teams?.away?.name || data.awayTeam || '';
      data.combinada.selections.forEach(sel => {
        // Requisito #9: only include bets with real odds
        if (sel.probability >= 65 && sel.odd && sel.odd > 1) {
          allBets.push({ ...sel, fixtureId: fid, matchName: mn, priority, matchTime, homeTeam, awayTeam });
        }
      });
    });
    // Sort: priority desc (upcoming first), then probability desc
    allBets.sort((a, b) => b.priority - a.priority || b.probability - a.probability);
    // Pick from different matches/teams - at least 3 from different teams
    const picked = [];
    const usedTeams = new Set();
    const usedMatches = new Set();
    for (const bet of allBets) {
      if (picked.length >= 5) break;
      // Skip if both teams in this match are already used
      if (usedTeams.has(bet.homeTeam) && usedTeams.has(bet.awayTeam)) continue;
      // Limit 1 pick per match to spread across games
      if (usedMatches.has(bet.fixtureId) && picked.length < 3) continue;
      picked.push(bet);
      usedTeams.add(bet.homeTeam);
      usedTeams.add(bet.awayTeam);
      usedMatches.add(bet.fixtureId);
    }
    // If we still have < 3, fill with remaining high-prob bets from any match
    if (picked.length < 3) {
      for (const bet of allBets) {
        if (picked.length >= 3) break;
        if (picked.some(p => p.fixtureId === bet.fixtureId && p.id === bet.id)) continue;
        picked.push(bet);
      }
    }
    const top = picked.slice(0, 5);
    if (top.length === 0) return null;
    const co = top.reduce((a, b) => b.odd ? a * b.odd : a, 1);
    const cp = top.reduce((a, b) => a + b.probability, 0) / top.length;
    return { selections: top, combinedOdd: +co.toFixed(2), combinedProbability: +cp.toFixed(1) };
  }, [analyzedData, fixtures]);

  const customCombinada = useMemo(() => {
    const all = [];
    Object.entries(selectedMarkets).forEach(([fid, markets]) => {
      Object.values(markets).forEach(m => all.push({ ...m, fixtureId: fid }));
    });
    if (all.length === 0) return null;
    const co = all.reduce((a, m) => m.odd ? a * m.odd : a, 1);
    const cp = all.reduce((a, m) => a + m.probability, 0) / all.length;
    return { selections: all, combinedOdd: +co.toFixed(2), combinedProbability: +cp.toFixed(1), highRisk: cp < 60 };
  }, [selectedMarkets]);

  const totalSel = Object.values(selectedMarkets).reduce((a, m) => a + Object.keys(m).length, 0);
  const analyzedFixtures = fixtures.filter(f => analyzed.includes(f.fixture.id));

  if (splash) {
    return (
      <motion.div
        className={`splash ${splashFade ? 'fade-out' : ''}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.6 }}
      >
        <div className="splash-content">
          <motion.div
            className="splash-logo-wrap"
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
          >
            <img src="/logo.png" alt="CFanalisis" className="splash-logo" />
          </motion.div>
          <motion.div
            className="splash-text"
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.5, duration: 0.5 }}
          >
            <span className="splash-welcome">Bienvenido a tu casa de</span>
            <span className="splash-brand">Analisis</span>
          </motion.div>
          <motion.div
            className="splash-loader"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.8 }}
          >
            <div className="splash-bar"><div className="splash-bar-fill" /></div>
            <span className="splash-loading">Cargando partidos...</span>
          </motion.div>
          <div className="splash-dots">
            <span className="splash-dot" /><span className="splash-dot" /><span className="splash-dot" />
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      className="app"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <div className="container">
        {/* HEADER */}
        <motion.header
          className="header"
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.1 }}
        >
          <img src="/vflogo.png" alt="CFanalisis" className="brand-logo" />
          <div className="header-right">
            {isOwner && (
              <div className="reanalyze-wrapper">
                <button
                  className="btn-reanalyze"
                  onClick={handleReanalyze}
                  disabled={reanalyzing}
                >
                  {reanalyzeDone
                    ? `Done: ${reanalyzeProgress?.analyzed || 0} nuevos, ${reanalyzeProgress?.skipped || 0} ya listos`
                    : reanalyzing
                      ? `${reanalyzeProgress ? Math.round((reanalyzeProgress.current / reanalyzeProgress.total) * 100) : 0}% — ${reanalyzeProgress?.match || 'Iniciando...'}`
                      : 'Re-analizar todo'}
                </button>
                {reanalyzing && reanalyzeProgress && (
                  <div className="reanalyze-bar">
                    <div
                      className="reanalyze-bar-fill"
                      style={{ width: `${Math.round((reanalyzeProgress.current / reanalyzeProgress.total) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            )}
            {user && (
              <div className="user-badge">
                <span className="user-name">{user?.name?.split(' ')[0] || user?.email?.split('@')[0]}</span>
                <button className="btn-signout" onClick={async () => { await supabase?.auth.signOut(); window.location.href = '/'; }}>Salir</button>
              </div>
            )}
            {pushSupported && (
              <button
                className={`btn-bell${pushEnabled ? ' btn-bell--on' : ''}`}
                onClick={handlePushToggle}
                title={pushEnabled ? 'Desactivar notificaciones de goles' : 'Activar notificaciones de goles'}
              >
                {pushEnabled ? '🔔' : '🔕'}
              </button>
            )}
            <button className="btn-reload" onClick={async () => { await refreshLiveData(); loadFixtures(date); }} disabled={loading || refreshingLive}>
              <span className={loading || refreshingLive ? 'spin' : ''}>&#8635;</span>
            </button>
          </div>
        </motion.header>

        {/* CONTROLS: Date + Filters */}
        <div className="controls-row">
          <div className="date-nav">
            <button onClick={() => changeDate(-1)}>&#9664;</button>
            <span className="date-display">
              {fmtDateDisplay(date, userTz)}
            </span>
            <button onClick={() => changeDate(1)}>&#9654;</button>
          </div>
          <div className="filters-row">
            <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="filter-sel">
              <option value="time">Hora</option>
              <option value="odds">Cuota</option>
              <option value="probability">Analisis</option>
            </select>
            <select value={leagueFilter} onChange={e => setLeagueFilter(e.target.value)} className="filter-sel">
              <option value="">Ligas</option>
              {Object.values(leagues).sort((a, b) => a.name.localeCompare(b.name)).map(l => (
                <option key={l.id} value={l.id}>{FLAGS[l.country] || ''} {l.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* TABS */}
        <div className="tabs">
          {[
            { key: 'partidos', label: 'Partidos', count: visible.length },
            { key: 'analizados', label: 'Analizados', count: analyzed.length },
            { key: 'combinada', label: 'Combinada', count: totalSel },
          ].map(t => (
            <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
              {t.count > 0 && <span className="tab-badge">{t.count}</span>}
            </button>
          ))}
        </div>

        {/* STATUS CHIPS */}
        {tab === 'partidos' && (
          <div className="chips">
            {[
              { key: 'all', label: 'Todos', count: visible.length },
              { key: 'live', label: 'En Vivo', count: liveCount },
              { key: 'upcoming', label: 'Proximos', count: upcomingCount },
              { key: 'finished', label: 'Finalizados' },
              { key: 'favoritos', label: '\u2605 Favoritos', count: favoriteCount },
            ].map(c => (
              <button key={c.key} className={`chip ${statusFilter === c.key ? 'active' : ''} ${c.key === 'live' && liveCount > 0 ? 'pulse' : ''}`} onClick={() => setStatusFilter(c.key)}>
                {c.key === 'live' && liveCount > 0 && <span className="dot-live" />}
                {c.label}
                {c.count > 0 && <span className="chip-n">{c.count}</span>}
              </button>
            ))}
          </div>
        )}

        {/* APUESTA DEL DIA */}
        {apuestaDelDia && tab === 'partidos' && (
          <div className={`apuesta ${showApuesta ? 'open' : ''}`}>
            <button className="apuesta-head" onClick={() => setShowApuesta(!showApuesta)}>
              <span className="apuesta-left">&#127919; Apuesta del Dia</span>
              <span className="apuesta-right">
                <span className="apuesta-pct">{cap(apuestaDelDia.combinedProbability)}%</span>
                <span className={`chev ${showApuesta ? 'up' : ''}`}>&#9662;</span>
              </span>
            </button>
            {showApuesta && (
              <div className="apuesta-body">
                {apuestaDelDia.selections.map((sel, i) => {
                  const pct = cap(sel.probability);
                  const probColor = pct >= 85 ? '#4ade80' : pct >= 80 ? '#fbbf24' : '#d97706';
                  return (
                    <div key={i} className={`apuesta-item ${sel.priority === 2 ? 'upcoming' : sel.priority === 1 ? 'live' : 'done'}`}>
                      <span className="apuesta-match">
                        {sel.priority === 2 && <span className="apuesta-status ns">&#9679;</span>}
                        {sel.priority === 1 && <span className="apuesta-status live">EN VIVO</span>}
                        {sel.priority === 0 && <span className="apuesta-status fin">FIN</span>}
                        {sel.matchName}
                      </span>
                      <span className="apuesta-mkt">{(() => {
                        const sufijos = { 'Goles': 'goles', 'Córners': 'córners', 'Tarjetas': 'tarjetas' };
                        const sufijo = sufijos[sel.cat];
                        if (sufijo && sel.name?.toLowerCase().endsWith(sufijo)) {
                          const valor = sel.name.slice(0, sel.name.length - sufijo.length).trim();
                          return <><span style={{ color: 'white', fontWeight: 600 }}>{sel.cat} totales — </span><span style={{ color: '#67e8f9' }}>{valor}</span></>;
                        }
                        return sel.name;
                      })()}</span>
                      <span className="apuesta-prob" style={{ color: probColor }}>{pct}%</span>
                      <span className="apuesta-odd">{sel.odd.toFixed(2)}</span>
                    </div>
                  );
                })}
                {apuestaDelDia.combinedOdd > 1 && (
                  <div className="apuesta-foot">
                    <span>Cuota: <b>{apuestaDelDia.combinedOdd}</b></span>
                    <span>Prob: <b>{cap(apuestaDelDia.combinedProbability)}%</b></span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* WARNING */}
        {error && fixtures.length > 0 && <div className="warn fade-in">{error}</div>}

        {/* LOADING */}
        {loading && (
          <div className="skeletons">
            {[0,1,2,3,4].map(i => <div key={i} className="skel" style={{ animationDelay: `${i * 0.1}s` }} />)}
          </div>
        )}

        {/* ERROR */}
        {!loading && error && fixtures.length === 0 && (
          <div className="empty-state fade-in">
            <div className="empty-icon">&#9889;</div>
            <h3>Sin conexion</h3>
            <p>{error}</p>
            <button className="btn-primary" onClick={() => loadFixtures(date)}>Reintentar</button>
          </div>
        )}

        {/* BATCH ANALYSIS RUNNING BANNER */}
        {batchRunning && !loading && fixtures.length > 0 && (
          <div className="batch-banner fade-in">
            <div className="spinner-sm" />
            <span>Analizando partidos del dia... Los datos se actualizan automaticamente.</span>
          </div>
        )}

        {/* TAB: PARTIDOS */}
        {!loading && tab === 'partidos' && (
          <>
            {sorted.length === 0 && !error && (
              <div className="empty-state fade-in">
                <div className="empty-icon">&#9917;</div>
                <h3>Sin partidos</h3>
                <p>No hay partidos para esta fecha</p>
              </div>
            )}
            {sorted.length > 0 && (
              <div className="match-list">
                {sorted.map((m, i) => {
                  const isMatchAnalyzed = analyzed.includes(m.fixture.id);
                  if (isMatchAnalyzed) {
                    return (
                      <AccordionCard
                        key={m.fixture.id}
                        match={m}
                        data={analyzedData[m.fixture.id]}
                        odds={analyzedOdds[m.fixture.id]}
                        standings={standings}
                        liveStats={liveStats[m.fixture.id]}
                        isExpanded={expandedMatch === m.fixture.id}
                        onToggle={() => setExpandedMatch(expandedMatch === m.fixture.id ? null : m.fixture.id)}
                        selMarkets={selectedMarkets[m.fixture.id] || {}}
                        onToggleMarket={(mkt) => toggleMarket(m.fixture.id, mkt, `${m.teams.home.name} vs ${m.teams.away.name}`)}
                        onViewFull={() => router.push(`/dashboard/analisis/${m.fixture.id}`)}
                        onRemove={(e) => dismissMatch(e, m.fixture.id)}
                        isFavorite={favorites.includes(m.fixture.id)}
                        onFavorite={(e) => toggleFavorite(e, m.fixture.id)}
                        idx={i}
                        userTz={userTz}
                      />
                    );
                  }
                  return (
                    <MatchCard
                      key={m.fixture.id}
                      match={m}
                      isAnalyzed={false}
                      isSelected={selected.has(m.fixture.id)}
                      isFavorite={favorites.includes(m.fixture.id)}
                      odds={analyzedOdds[m.fixture.id]}
                      standings={standings}
                      matchData={analyzedData[m.fixture.id]}
                      liveStats={liveStats[m.fixture.id]}
                      onSelect={() => toggleSelect(m.fixture.id)}
                      onHide={(e) => doHide(e, m.fixture.id)}
                      onFavorite={(e) => toggleFavorite(e, m.fixture.id)}
                      onView={() => router.push(`/dashboard/analisis/${m.fixture.id}`)}
                      idx={i}
                      userTz={userTz}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* TAB: ANALIZADOS */}
        {!loading && tab === 'analizados' && (
          <>
            {analyzedFixtures.length === 0 ? (
              <div className="empty-state fade-in">
                <div className="empty-icon">&#128269;</div>
                <h3>Sin analisis</h3>
                <p>Selecciona partidos y analízalos</p>
              </div>
            ) : (
              <div className="match-list">
                {analyzedFixtures.map((m, i) => (
                  <AccordionCard
                    key={m.fixture.id}
                    match={m}
                    data={analyzedData[m.fixture.id]}
                    odds={analyzedOdds[m.fixture.id]}
                    standings={standings}
                    liveStats={liveStats[m.fixture.id]}
                    isExpanded={expandedMatch === m.fixture.id}
                    onToggle={() => setExpandedMatch(expandedMatch === m.fixture.id ? null : m.fixture.id)}
                    selMarkets={selectedMarkets[m.fixture.id] || {}}
                    onToggleMarket={(mkt) => toggleMarket(m.fixture.id, mkt, `${m.teams.home.name} vs ${m.teams.away.name}`)}
                    onViewFull={() => router.push(`/dashboard/analisis/${m.fixture.id}`)}
                    onRemove={(e) => removeFromAnalyzed(e, m.fixture.id)}
                    isFavorite={favorites.includes(m.fixture.id)}
                    onFavorite={(e) => toggleFavorite(e, m.fixture.id)}
                    idx={i}
                    userTz={userTz}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* TAB: COMBINADA */}
        {!loading && tab === 'combinada' && (
          <>
            {!customCombinada ? (
              <div className="empty-state fade-in">
                <div className="empty-icon">&#127920;</div>
                <h3>Combinada vacia</h3>
                <p>Ve a Analizados, abre un partido y selecciona apuestas</p>
              </div>
            ) : (
              <div className="comb-builder fade-in">
                <h3 className="comb-title">Tu Combinada &mdash; {customCombinada.selections.length} selecciones</h3>
                <div className="comb-list">
                  {customCombinada.selections.map((sel, i) => (
                    <div key={`${sel.fixtureId}-${sel.id}`} className="comb-item">
                      <div className="comb-item-match">{sel.matchName}</div>
                      <div className="comb-item-row">
                        <span className="comb-item-name">{sel.name}</span>
                        <span className={`comb-item-prob ${sel.probability >= 75 ? 'high' : sel.probability >= 50 ? 'mid' : 'low'}`}>{cap(sel.probability)}%</span>
                        <span className="comb-item-odd">{sel.odd ? sel.odd.toFixed(2) : ''}</span>
                        <button className="comb-item-rm" onClick={() => toggleMarket(sel.fixtureId, sel, sel.matchName)}>&#10005;</button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="comb-summary">
                  <div className="comb-sum-row">
                    <span>Cuota total (x{customCombinada.selections.length})</span>
                    <strong className="comb-odd-total">{customCombinada.combinedOdd}</strong>
                  </div>
                  <div className="comb-sum-row">
                    <span>Probabilidad compuesta</span>
                    <strong className={customCombinada.highRisk ? 'danger' : 'safe'}>{cap(customCombinada.combinedProbability)}%</strong>
                  </div>
                  <div className="comb-formula">
                    {customCombinada.selections.map((s, i) => (
                      <span key={i}>{i > 0 && ' x '}{cap(s.probability)}%</span>
                    ))}
                    <span> = {cap(customCombinada.combinedProbability)}%</span>
                  </div>
                  {customCombinada.highRisk && <div className="comb-warn">Combinada de alto riesgo (&lt;60%)</div>}
                </div>
                <div className="comb-actions">
                  <button className="btn-save-comb" onClick={saveCombinada} disabled={savingComb}>
                    {savingComb ? 'Guardando...' : 'Guardar combinada'}
                  </button>
                  <button className="btn-clear" onClick={() => setSelectedMarkets({})}>Limpiar</button>
                </div>

                {/* Saved combinadas */}
                {savedCombinadas.length > 0 && (
                  <div className="saved-combs">
                    <h4 className="saved-combs-title">Combinadas guardadas</h4>
                    {savedCombinadas.map(comb => (
                      <div key={comb.id} className="saved-comb">
                        <div className="saved-comb-head">
                          <span className="saved-comb-name">{comb.name}</span>
                          <button className="saved-comb-del" onClick={() => deleteSavedCombinada(comb.id)}>&#10005;</button>
                        </div>
                        <div className="saved-comb-info">
                          <span>{comb.selections.length} sel.</span>
                          <span className="saved-comb-odd">{comb.combinedOdd}x</span>
                          <span className={comb.combinedProbability >= 60 ? 'safe' : 'danger'}>{cap(comb.combinedProbability)}%</span>
                        </div>
                        <div className="saved-comb-sels">
                          {comb.selections.map((s, i) => (
                            <span key={i} className="saved-sel-chip">{s.name || s.market} {s.odd ? `(${s.odd.toFixed(2)})` : ''}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* FLOATING: Analyze */}
        {selected.size > 0 && tab === 'partidos' && (
          <div className="float-bar slide-up">
            <button className="btn-analyze" onClick={analyzeSelected} disabled={analyzing}>
              {analyzing ? 'Analizando...' : `Analizar ${selected.size} partido${selected.size > 1 ? 's' : ''}`}
            </button>
          </div>
        )}

        {/* FLOATING: Combinada counter */}
        {totalSel > 0 && tab === 'analizados' && (
          <div className="float-bar slide-up">
            <button className="btn-comb-float" onClick={() => setTab('combinada')}>
              &#127920; Ver Combinada ({totalSel})
              {customCombinada && <span className="float-odd">{customCombinada.combinedOdd}x</span>}
            </button>
          </div>
        )}

        {/* ANALYZING OVERLAY */}
        {analyzing && (
          <div className="overlay">
            <div className="overlay-card">
              <div className="spinner" />
              <p>Analizando {selected.size} partido{selected.size > 1 ? 's' : ''}...</p>
              <div className="progress"><div className="progress-bar" /></div>
              <small>Recopilando estadisticas</small>
            </div>
          </div>
        )}

        {/* FOOTER */}
        <div className="footer">
          <span>{quota.used} API calls</span>
          <span>{fromCache ? 'Cache' : 'API'}</span>
          <span>{visible.length} partidos</span>
        </div>
      </div>
    </motion.div>
  );
}

/* ======================== MATCH CARD ======================== */

function MatchCard({ match, isAnalyzed, isSelected, isFavorite, odds, standings, matchData, liveStats, onSelect, onHide, onFavorite, onView, idx, userTz }) {
  const live = isLive(match.fixture.status.short);
  const finished = isFinished(match.fixture.status.short);
  const hasScore = live || finished;
  const meta = match.leagueMeta || {};
  const flag = FLAGS[meta.country] || '';
  const homePos = matchData?.homePosition || standings?.[match.teams.home.id];
  const awayPos = matchData?.awayPosition || standings?.[match.teams.away.id];
  const homeId = match.teams.home.id;
  const tz = userTz || 'UTC';
  const cardDate = new Date(match.fixture.date).toLocaleDateString('es', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' });
  const sLabel = { NS: 'PRÓXIMO', '1H': 'EN VIVO — 1T', '2H': 'EN VIVO — 2T', HT: 'ENTRETIEMPO', FT: 'FINALIZADO', ET: 'EN VIVO — Extra', P: 'EN VIVO — Penales', AET: 'FINALIZADO', PEN: 'FINALIZADO', SUSP: 'SUSPENDIDO', PST: 'POSPUESTO', CANC: 'CANCELADO' }[match.fixture.status.short] || match.fixture.status.short;

  return (
    <motion.div
      className={`mcard ${live ? 'live' : ''} ${finished ? 'fin' : ''} ${isSelected ? 'sel' : ''} ${isAnalyzed ? 'done' : ''} stagger`}
      style={{ '--i': idx }}
      onClick={isAnalyzed ? onView : onSelect}
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: idx * 0.03 }}
      whileHover={{ scale: 1.01 }}
      layout
    >
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── Fila 1: Liga + Fecha ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.82rem', fontWeight: 600, color: '#f1f5f9' }}>
            {match.league.logo && <img src={match.league.logo} alt="" style={{ width: 18, height: 18, objectFit: 'contain' }} />}
            <span>{flag} {match.league.name}</span>
          </div>
          <span style={{ fontSize: '.75rem', color: 'rgba(255,255,255,.6)', textTransform: 'capitalize' }}>{cardDate}</span>
        </div>

        {/* ── Fila 2: Local | Visitante + Cuotas ── */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 12px' }}>
          {/* Local — order 1 */}
          <div style={{ order: 1, flex: 1, minWidth: 0 }}>
            <TeamLogo src={match.teams.home.logo} name={match.teams.home.name} size={36} />
            <div style={{ fontSize: 'clamp(.9rem, 3vw, 1.25rem)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 4, color: '#f1f5f9' }}>
              {match.teams.home.name}
            </div>
            {homePos && <div style={{ fontSize: '.7rem', color: 'rgba(255,255,255,.55)' }}>{homePos}° posición</div>}
          </div>

          {/* Cuotas — order 3, fila propia en móvil */}
          {odds && (
            <div style={{ order: 3, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <span style={{ padding: '4px 12px', background: 'rgba(251,191,36,.1)', border: '1px solid rgba(251,191,36,.2)', borderRadius: 8, fontWeight: 700, fontSize: '.82rem', color: '#fbbf24' }}>{odds.home?.toFixed(2)}</span>
              <span style={{ padding: '4px 12px', background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 8, fontWeight: 700, fontSize: '.82rem', color: 'rgba(255,255,255,.55)' }}>X {odds.draw?.toFixed(2)}</span>
              <span style={{ padding: '4px 12px', background: 'rgba(251,191,36,.1)', border: '1px solid rgba(251,191,36,.2)', borderRadius: 8, fontWeight: 700, fontSize: '.82rem', color: '#fbbf24' }}>{odds.away?.toFixed(2)}</span>
            </div>
          )}

          {/* Visitante — order 2 */}
          <div style={{ order: 2, flex: 1, minWidth: 0, textAlign: 'right' }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <TeamLogo src={match.teams.away.logo} name={match.teams.away.name} size={36} />
            </div>
            <div style={{ fontSize: 'clamp(.9rem, 3vw, 1.25rem)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 4, color: '#f1f5f9' }}>
              {match.teams.away.name}
            </div>
            {awayPos && <div style={{ fontSize: '.7rem', color: 'rgba(255,255,255,.55)' }}>{awayPos}° posición</div>}
          </div>
        </div>

        {/* ── Score Box ── igual al de analisis/[id] */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <motion.div
            style={{ width: '100%', borderRadius: 20, background: 'linear-gradient(135deg, rgba(30,135,105,.25), rgba(0,0,9,.4), rgba(30,135,105,.15))', border: '2px solid rgba(30,135,105,.5)', padding: '16px 20px', backdropFilter: 'blur(8px)' }}
            animate={{ boxShadow: ['0 0 30px rgba(30,135,105,.3)', '0 0 50px rgba(30,135,105,.6)', '0 0 30px rgba(30,135,105,.3)'] }}
            transition={{ duration: 2, repeat: Infinity }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>

              {/* Badge de estado */}
              <div>
                {live ? (
                  <motion.div
                    className="ap2-live-badge"
                    animate={{ boxShadow: ['0 0 8px rgba(220,38,38,.6)', '0 0 18px rgba(220,38,38,1)', '0 0 8px rgba(220,38,38,.6)'] }}
                    transition={{ duration: 1.2, repeat: Infinity }}
                  >
                    <motion.span className="ap2-live-dot" animate={{ opacity: [1, .3, 1] }} transition={{ duration: 1, repeat: Infinity }} />
                    {match.fixture.status.short === 'HT' ? 'ENTRETIEMPO' : 'EN VIVO'}
                    {match.fixture.status.elapsed > 0 && (
                      <span style={{ marginLeft: 4 }}>
                        <MatchTimer elapsed={match.fixture.status.elapsed} status={match.fixture.status.short} />
                      </span>
                    )}
                  </motion.div>
                ) : (
                  <div style={{ padding: '4px 14px', borderRadius: 999, background: 'rgba(255,255,255,.1)', fontSize: '.75rem', fontWeight: 700, color: 'white', letterSpacing: '.05em' }}>
                    {sLabel}
                  </div>
                )}
              </div>

              {/* Marcador o Hora */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {hasScore ? (
                  <>
                    <motion.span
                      style={{ fontSize: 'clamp(2.5rem, 8vw, 3.5rem)', fontWeight: 700, lineHeight: 1, color: '#f1f5f9' }}
                      animate={{ textShadow: ['0 0 15px rgba(30,135,105,.5)', '0 0 25px rgba(30,135,105,1)', '0 0 15px rgba(30,135,105,.5)'] }}
                      transition={{ duration: 2, repeat: Infinity }}
                    >
                      {match.goals.home}
                    </motion.span>

                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
                      {liveStats?.corners && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 8, background: 'rgba(255,255,255,.1)', fontSize: '.75rem', fontWeight: 700, color: '#f1f5f9' }}>
                          <span style={{ color: '#fbbf24' }}>🚩</span>
                          <span>{liveStats.corners.home}</span>
                          <span style={{ color: 'rgba(255,255,255,.4)' }}>-</span>
                          <span>{liveStats.corners.away}</span>
                          <span style={{ color: 'rgba(255,255,255,.4)', fontWeight: 400 }}>({liveStats.corners.home + liveStats.corners.away})</span>
                        </div>
                      )}
                      {liveStats?.yellowCards && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 8, background: 'rgba(255,255,255,.1)', fontSize: '.75rem', fontWeight: 700 }}>
                          <span style={{ color: '#fbbf24' }}>🟨{liveStats.yellowCards.home}</span>
                          <span style={{ color: '#ef4444' }}>🟥{liveStats.redCards?.home ?? 0}</span>
                          <span style={{ color: 'rgba(255,255,255,.4)' }}>|</span>
                          <span style={{ color: '#fbbf24' }}>🟨{liveStats.yellowCards.away}</span>
                          <span style={{ color: '#ef4444' }}>🟥{liveStats.redCards?.away ?? 0}</span>
                        </div>
                      )}
                    </div>

                    <span style={{ fontSize: 'clamp(2.5rem, 8vw, 3.5rem)', fontWeight: 700, lineHeight: 1, color: '#f1f5f9' }}>
                      {match.goals.away}
                    </span>
                  </>
                ) : (
                  <div style={{ fontSize: 'clamp(1.5rem, 5vw, 2rem)', fontWeight: 700, color: '#f1f5f9' }}>
                    {fmtTime(match.fixture.date, userTz)}
                  </div>
                )}
              </div>

              {/* Goleadores — 2 columnas igual al analisis */}
              {liveStats && (liveStats.goalScorers?.length > 0 || liveStats.missedPenalties?.length > 0) && (
                <div style={{ width: '100%', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {liveStats.goalScorers?.filter(g => g.teamId === homeId).map((g, i) => (
                      <div key={i} style={{ fontSize: '.75rem', fontWeight: 600, color: '#6ee7b7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {g.minute}{g.extra ? `+${g.extra}` : ''}&#39; {g.player}{g.type === 'Penalty' ? ' (P)' : g.type === 'Own Goal' ? ' (AG)' : ''}
                      </div>
                    ))}
                    {liveStats.missedPenalties?.filter(p => p.teamId === homeId).map((p, i) => (
                      <div key={i} style={{ fontSize: '.75rem', color: '#fb923c', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.player} ✗ {p.minute}&#39;
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'right' }}>
                    {liveStats.goalScorers?.filter(g => g.teamId !== homeId).map((g, i) => (
                      <div key={i} style={{ fontSize: '.75rem', fontWeight: 600, color: '#f1f5f9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {g.minute}{g.extra ? `+${g.extra}` : ''}&#39; {g.player}{g.type === 'Penalty' ? ' (P)' : g.type === 'Own Goal' ? ' (AG)' : ''}
                      </div>
                    ))}
                    {liveStats.missedPenalties?.filter(p => p.teamId !== homeId).map((p, i) => (
                      <div key={i} style={{ fontSize: '.75rem', color: '#fb923c', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        ✗ {p.minute}&#39; {p.player}
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          </motion.div>
        </div>

        {/* ── Footer: selección / favorito / ocultar ── */}
        <div className="mcard-foot">
          {isAnalyzed ? (
            <span className="tag-done">&#10003; ANALIZADO</span>
          ) : (
            <label className="mcard-cb" onClick={e => e.stopPropagation()}>
              <input type="checkbox" checked={isSelected} onChange={onSelect} />
              <span className="cb-mark" />
            </label>
          )}
          {onFavorite && (
            <button
              className={`btn-fav${isFavorite ? ' active' : ''}`}
              onClick={onFavorite}
              title={isFavorite ? 'Quitar de favoritos' : 'Agregar a favoritos'}
            >&#9733;</button>
          )}
          <button className="btn-x" onClick={(e) => { e.stopPropagation(); onHide(e); }}>&#10005;</button>
        </div>

      </div>
    </motion.div>
  );
}

/* ======================== ACCORDION CARD ======================== */

function AccordionCard({ match, data, odds, standings, liveStats, isExpanded, onToggle, selMarkets, onToggleMarket, onViewFull, onRemove, isFavorite, onFavorite, idx, userTz }) {
  const live = isLive(match.fixture.status.short);
  const finished = isFinished(match.fixture.status.short);
  const hasScore = live || finished;
  const meta = match.leagueMeta || {};
  const flag = FLAGS[meta.country] || '';
  const selCount = Object.keys(selMarkets).length;
  const homePos = data?.homePosition || standings?.[match.teams.home.id];
  const awayPos = data?.awayPosition || standings?.[match.teams.away.id];
  const winProb = data?.calculatedProbabilities?.winner;
  const homeId = match.teams.home.id;
  const tz = userTz || 'UTC';
  const cardDate = new Date(match.fixture.date).toLocaleDateString('es', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' });
  const sLabel = { NS: 'PRÓXIMO', '1H': 'EN VIVO — 1T', '2H': 'EN VIVO — 2T', HT: 'ENTRETIEMPO', FT: 'FINALIZADO', ET: 'EN VIVO — Extra', P: 'EN VIVO — Penales', AET: 'FINALIZADO', PEN: 'FINALIZADO', SUSP: 'SUSPENDIDO', PST: 'POSPUESTO', CANC: 'CANCELADO' }[match.fixture.status.short] || match.fixture.status.short;

  const markets = useMemo(() => {
    if (!data?.calculatedProbabilities) return [];
    const p = data.calculatedProbabilities;
    const o = data.odds;
    const m = [];
    if (p.btts >= 50) m.push({ id: 'btts-yes', name: 'Ambos marcan SI', probability: p.btts, odd: o?.btts?.yes || null, cat: 'BTTS' });
    if (p.bttsNo >= 50) m.push({ id: 'btts-no', name: 'Ambos marcan NO', probability: p.bttsNo, odd: o?.btts?.no || null, cat: 'BTTS' });
    if (p.winner?.home >= 30) m.push({ id: 'w-h', name: `Gana ${match.teams.home.name}`, probability: p.winner.home, odd: o?.matchWinner?.home || null, cat: 'Ganador' });
    if (p.winner?.draw >= 20) m.push({ id: 'w-d', name: 'Empate', probability: p.winner.draw, odd: o?.matchWinner?.draw || null, cat: 'Ganador' });
    if (p.winner?.away >= 30) m.push({ id: 'w-a', name: `Gana ${match.teams.away.name}`, probability: p.winner.away, odd: o?.matchWinner?.away || null, cat: 'Ganador' });
    if (p.overUnder) {
      m.push({ id: 'o15', name: 'Más de 1.5 goles', probability: p.overUnder.over15, odd: o?.overUnder?.['Over_1_5'] || null, cat: 'Goles' });
      m.push({ id: 'o25', name: 'Más de 2.5 goles', probability: p.overUnder.over25, odd: o?.overUnder?.['Over_2_5'] || null, cat: 'Goles' });
      m.push({ id: 'o35', name: 'Más de 3.5 goles', probability: p.overUnder.over35, odd: o?.overUnder?.['Over_3_5'] || null, cat: 'Goles' });
      m.push({ id: 'u25', name: 'Menos de 2.5 goles', probability: p.overUnder.under25, odd: o?.overUnder?.['Under_2_5'] || null, cat: 'Goles' });
    }
    if (p.corners) {
      m.push({ id: 'c85', name: 'Más de 8.5 córners', probability: p.corners.over85, odd: null, cat: 'Córners' });
      m.push({ id: 'c95', name: 'Más de 9.5 córners', probability: p.corners.over95, odd: null, cat: 'Córners' });
    }
    if (p.cards) {
      m.push({ id: 'k25', name: 'Más de 2.5 tarjetas', probability: p.cards.over25, odd: null, cat: 'Tarjetas' });
      m.push({ id: 'k35', name: 'Más de 3.5 tarjetas', probability: p.cards.over35, odd: null, cat: 'Tarjetas' });
    }
    // Show all markets with high probability — odds optional
    return m
      .filter(x => x.probability >= 70 && x.probability <= 95)
      .sort((a, b) => b.probability - a.probability);
  }, [data, match]);

  return (
    <div className={`acc-card ${isExpanded ? 'open' : ''}`}>
      {/* Header */}
      <div className="acc-head" onClick={onToggle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* ── Fila 1: Liga + Fecha ── */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.82rem', fontWeight: 600, color: '#f1f5f9' }}>
              {match.league.logo && <img src={match.league.logo} alt="" style={{ width: 18, height: 18, objectFit: 'contain' }} />}
              <span>{flag} {match.league.name}</span>
            </div>
            <span style={{ fontSize: '.75rem', color: 'rgba(255,255,255,.6)', textTransform: 'capitalize' }}>{cardDate}</span>
          </div>

          {/* ── Fila 2: Local | Visitante + Cuotas ── */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 12px' }}>
            {/* Local */}
            <div style={{ order: 1, flex: 1, minWidth: 0 }}>
              <TeamLogo src={match.teams.home.logo} name={match.teams.home.name} size={36} />
              <div style={{ fontSize: 'clamp(.9rem, 3vw, 1.25rem)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 4, color: '#f1f5f9' }}>
                {match.teams.home.name}
              </div>
              {homePos && <div style={{ fontSize: '.7rem', color: 'rgba(255,255,255,.55)' }}>{homePos}° posición</div>}
            </div>

            {/* Cuotas */}
            {odds && (
              <div style={{ order: 3, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <span style={{ padding: '4px 12px', background: 'rgba(251,191,36,.1)', border: '1px solid rgba(251,191,36,.2)', borderRadius: 8, fontWeight: 700, fontSize: '.82rem', color: '#fbbf24' }}>{odds.home?.toFixed(2)}</span>
                <span style={{ padding: '4px 12px', background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 8, fontWeight: 700, fontSize: '.82rem', color: 'rgba(255,255,255,.55)' }}>X {odds.draw?.toFixed(2)}</span>
                <span style={{ padding: '4px 12px', background: 'rgba(251,191,36,.1)', border: '1px solid rgba(251,191,36,.2)', borderRadius: 8, fontWeight: 700, fontSize: '.82rem', color: '#fbbf24' }}>{odds.away?.toFixed(2)}</span>
              </div>
            )}

            {/* Visitante */}
            <div style={{ order: 2, flex: 1, minWidth: 0, textAlign: 'right' }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <TeamLogo src={match.teams.away.logo} name={match.teams.away.name} size={36} />
              </div>
              <div style={{ fontSize: 'clamp(.9rem, 3vw, 1.25rem)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 4, color: '#f1f5f9' }}>
                {match.teams.away.name}
              </div>
              {awayPos && <div style={{ fontSize: '.7rem', color: 'rgba(255,255,255,.55)' }}>{awayPos}° posición</div>}
            </div>
          </div>

          {/* ── Score Box ── */}
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <motion.div
              style={{ width: '100%', borderRadius: 20, background: 'linear-gradient(135deg, rgba(30,135,105,.25), rgba(0,0,9,.4), rgba(30,135,105,.15))', border: '2px solid rgba(30,135,105,.5)', padding: '16px 20px', backdropFilter: 'blur(8px)' }}
              animate={{ boxShadow: ['0 0 30px rgba(30,135,105,.3)', '0 0 50px rgba(30,135,105,.6)', '0 0 30px rgba(30,135,105,.3)'] }}
              transition={{ duration: 2, repeat: Infinity }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>

                {/* Badge de estado */}
                <div>
                  {live ? (
                    <motion.div
                      className="ap2-live-badge"
                      animate={{ boxShadow: ['0 0 8px rgba(220,38,38,.6)', '0 0 18px rgba(220,38,38,1)', '0 0 8px rgba(220,38,38,.6)'] }}
                      transition={{ duration: 1.2, repeat: Infinity }}
                    >
                      <motion.span className="ap2-live-dot" animate={{ opacity: [1, .3, 1] }} transition={{ duration: 1, repeat: Infinity }} />
                      {match.fixture.status.short === 'HT' ? 'ENTRETIEMPO' : 'EN VIVO'}
                      {match.fixture.status.elapsed > 0 && (
                        <span style={{ marginLeft: 4 }}>
                          <MatchTimer elapsed={match.fixture.status.elapsed} status={match.fixture.status.short} />
                        </span>
                      )}
                    </motion.div>
                  ) : (
                    <div style={{ padding: '4px 14px', borderRadius: 999, background: 'rgba(255,255,255,.1)', fontSize: '.75rem', fontWeight: 700, color: 'white', letterSpacing: '.05em' }}>
                      {sLabel}
                    </div>
                  )}
                </div>

                {/* Marcador o Hora */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {hasScore ? (
                    <>
                      <motion.span
                        style={{ fontSize: 'clamp(2.5rem, 8vw, 3.5rem)', fontWeight: 700, lineHeight: 1, color: '#f1f5f9' }}
                        animate={{ textShadow: ['0 0 15px rgba(30,135,105,.5)', '0 0 25px rgba(30,135,105,1)', '0 0 15px rgba(30,135,105,.5)'] }}
                        transition={{ duration: 2, repeat: Infinity }}
                      >
                        {match.goals.home}
                      </motion.span>

                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
                        {liveStats?.corners && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 8, background: 'rgba(255,255,255,.1)', fontSize: '.75rem', fontWeight: 700, color: '#f1f5f9' }}>
                            <span style={{ color: '#fbbf24' }}>🚩</span>
                            <span>{liveStats.corners.home}</span>
                            <span style={{ color: 'rgba(255,255,255,.4)' }}>-</span>
                            <span>{liveStats.corners.away}</span>
                            <span style={{ color: 'rgba(255,255,255,.4)', fontWeight: 400 }}>({liveStats.corners.home + liveStats.corners.away})</span>
                          </div>
                        )}
                        {liveStats?.yellowCards && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 8, background: 'rgba(255,255,255,.1)', fontSize: '.75rem', fontWeight: 700 }}>
                            <span style={{ color: '#fbbf24' }}>🟨{liveStats.yellowCards.home}</span>
                            <span style={{ color: '#ef4444' }}>🟥{liveStats.redCards?.home ?? 0}</span>
                            <span style={{ color: 'rgba(255,255,255,.4)' }}>|</span>
                            <span style={{ color: '#fbbf24' }}>🟨{liveStats.yellowCards.away}</span>
                            <span style={{ color: '#ef4444' }}>🟥{liveStats.redCards?.away ?? 0}</span>
                          </div>
                        )}
                      </div>

                      <span style={{ fontSize: 'clamp(2.5rem, 8vw, 3.5rem)', fontWeight: 700, lineHeight: 1, color: '#f1f5f9' }}>
                        {match.goals.away}
                      </span>
                    </>
                  ) : (
                    <div style={{ fontSize: 'clamp(1.5rem, 5vw, 2rem)', fontWeight: 700, color: '#f1f5f9' }}>
                      {fmtTime(match.fixture.date, userTz)}
                    </div>
                  )}
                </div>

                {/* Goleadores — 2 columnas */}
                {liveStats && (liveStats.goalScorers?.length > 0 || liveStats.missedPenalties?.length > 0) && (
                  <div style={{ width: '100%', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {liveStats.goalScorers?.filter(g => g.teamId === homeId).map((g, i) => (
                        <div key={i} style={{ fontSize: '.75rem', fontWeight: 600, color: '#6ee7b7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {g.minute}{g.extra ? `+${g.extra}` : ''}&#39; {g.player}{g.type === 'Penalty' ? ' (P)' : g.type === 'Own Goal' ? ' (AG)' : ''}
                        </div>
                      ))}
                      {liveStats.missedPenalties?.filter(p => p.teamId === homeId).map((p, i) => (
                        <div key={i} style={{ fontSize: '.75rem', color: '#fb923c', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.player} ✗ {p.minute}&#39;
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'right' }}>
                      {liveStats.goalScorers?.filter(g => g.teamId !== homeId).map((g, i) => (
                        <div key={i} style={{ fontSize: '.75rem', fontWeight: 600, color: '#f1f5f9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {g.minute}{g.extra ? `+${g.extra}` : ''}&#39; {g.player}{g.type === 'Penalty' ? ' (P)' : g.type === 'Own Goal' ? ' (AG)' : ''}
                        </div>
                      ))}
                      {liveStats.missedPenalties?.filter(p => p.teamId !== homeId).map((p, i) => (
                        <div key={i} style={{ fontSize: '.75rem', color: '#fb923c', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          ✗ {p.minute}&#39; {p.player}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              </div>
            </motion.div>
          </div>

          {/* ── Indicador: remove / fav / selCount / prob / chevron ── */}
          <div className="acc-indicator">
            {onRemove && (
              <button className="btn-x acc-rm" onClick={e => { e.stopPropagation(); onRemove(e); }} title="Eliminar de analizados">&#10005;</button>
            )}
            {onFavorite && (
              <button
                className={`btn-fav${isFavorite ? ' active' : ''}`}
                onClick={e => { e.stopPropagation(); onFavorite(e); }}
                title={isFavorite ? 'Quitar de favoritos' : 'Agregar a favoritos'}
              >&#9733;</button>
            )}
            {selCount > 0 && <span className="acc-sel-count">{selCount} sel.</span>}
            {data?.combinada && (data.combinada.selections || []).length > 0 && (
              <span className="acc-mini">
                {cap(data.combinada.combinedProbability)}%
                {data.combinada.combinedOdd > 1 ? ` | ${data.combinada.combinedOdd}x` : ''}
              </span>
            )}
            <span className={`chev-ico ${isExpanded ? 'up' : ''}`}>&#9662;</span>
          </div>

        </div>
      </div>

      {/* Content */}
      <div className={`acc-content ${isExpanded ? 'open' : ''}`}>
        <div className="acc-inner">
          {data ? (
            <>
              {/* Live match details */}
              {(live || finished) && liveStats && (
                <LiveMatchDetails stats={liveStats} homeTeam={match.teams.home} awayTeam={match.teams.away} />
              )}

              {/* Selectable markets — BEFORE auto combinada */}
              {markets.length > 0 && <div className="markets">
                <h4 className="markets-title">Selecciona para tu combinada</h4>
                <div className="markets-grid">
                  {markets.map(mkt => {
                    const checked = !!selMarkets[mkt.id];
                    const bkInfo = (() => {
                      if (!data?.odds) return null;
                      const country = detectCountry();
                      const catMap = { 'BTTS': 'btts', 'Ganador': 'matchWinner', 'Goles': 'overUnder', 'Corners': 'corners', 'Tarjetas': 'cards' };
                      return selectBookmakerOdds(data.odds, catMap[mkt.cat] || mkt.cat, country);
                    })();
                    return (
                      <button
                        key={mkt.id}
                        className={`mkt ${checked ? 'on' : ''} ${mkt.probability >= 75 ? 'hi' : mkt.probability >= 50 ? 'md' : 'lo'}`}
                        onClick={(e) => { e.stopPropagation(); onToggleMarket(mkt); }}
                      >
                        <span className="mkt-name">{mkt.name}</span>
                        <div className="mkt-bar"><div className="mkt-fill" style={{ width: `${cap(mkt.probability)}%` }} /></div>
                        <div className="mkt-nums">
                          <span className="mkt-pct">{cap(mkt.probability)}%</span>
                          {mkt.odd && <span className="mkt-odd">{mkt.odd.toFixed(2)}</span>}
                          {bkInfo && (() => {
                            const logo = BOOKMAKER_LOGOS[bkInfo.bookmaker?.toLowerCase()] || Object.entries(BOOKMAKER_LOGOS).find(([k]) => bkInfo.bookmaker?.toLowerCase()?.includes(k))?.[1];
                            return logo ? <span className="mkt-bk"><img src={logo} alt="" className="bk-logo-lg" /></span> : null;
                          })()}
                          {checked && <span className="mkt-chk">&#10003;</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>}

              {/* Auto combinada */}
              {(() => {
                const allSels = data.combinada?.selections || [];
                if (allSels.length === 0) return null;
                const withOdds = allSels.filter(s => s.odd && s.odd > 1);
                const cOdd = withOdds.length >= 2 ? withOdds.reduce((a, s) => a * s.odd, 1) : null;
                const cProb = Math.round(allSels.reduce((a, s) => a + s.probability, 0) / allSels.length);
                return (
                  <div className="auto-comb">
                    <div className="auto-comb-head">
                      <span>&#127942; Combinada Auto</span>
                      <span className={`auto-comb-val ${cProb < 70 ? 'danger' : 'safe'}`}>
                        {cap(cProb)}%{cOdd ? ` · ${cOdd.toFixed(2)}x` : ''}
                      </span>
                    </div>
                    <div className="auto-comb-chips">
                      {allSels.map((s, i) => (
                        <span key={i} className="auto-chip">
                          {s.name} <b>{cap(s.probability)}%</b>
                          {s.odd && s.odd > 1 ? ` (${s.odd.toFixed(2)})` : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Últimos 5 partidos por equipo */}
              <Last5Block
                homeLastFive={data.homeLastFive}
                awayLastFive={data.awayLastFive}
                homeName={match.teams.home.name}
                awayName={match.teams.away.name}
                homeLogo={match.teams.home.logo}
                awayLogo={match.teams.away.logo}
              />

              {/* Estadísticas de los últimos 5: avg/max/min */}
              <StatsBlock
                homeLastFive={data.homeLastFive}
                awayLastFive={data.awayLastFive}
                homeName={match.teams.home.name}
                awayName={match.teams.away.name}
                goalTiming={data.calculatedProbabilities?.goalTiming}
                playerHighlights={data.playerHighlights}
              />

              <button className="btn-full" onClick={(e) => { e.stopPropagation(); onViewFull(); }}>
                Ver analisis completo &#8594;
              </button>
            </>
          ) : (
            <div className="no-data-inline">Sin datos de analisis</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ======================== LIVE STATS COMPONENTS ======================== */

function MatchTimer({ elapsed, status }) {
  const [localElapsed, setLocalElapsed] = useState(elapsed || 0);
  const [seconds, setSeconds] = useState(0);
  // Tracks the highest minute accepted — prevents backwards jumps when API
  // keeps returning elapsed:90 while the local counter has advanced past it
  const maxElapsedRef = useRef(elapsed || 0);

  useEffect(() => {
    const newElapsed = elapsed || 0;
    // Only advance if the API sends a strictly higher minute
    if (newElapsed > maxElapsedRef.current) {
      maxElapsedRef.current = newElapsed;
      setLocalElapsed(newElapsed);
      setSeconds(0);
    }

    if (status !== '1H' && status !== '2H' && status !== 'ET') return;

    const interval = setInterval(() => {
      setSeconds(prev => {
        if (prev >= 59) {
          maxElapsedRef.current += 1;
          setLocalElapsed(m => m + 1);
          return 0;
        }
        return prev + 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [status, elapsed]);

  if (status === 'HT') return <span>ET</span>;
  if (status === 'BT') return <span>Descanso ET</span>;
  if (status === 'P') return <span>Penales</span>;

  return <span>{localElapsed}:{String(seconds).padStart(2, '0')}</span>;
}

function LiveStatsBar({ stats }) {
  if (!stats) return null;
  const { corners, yellowCards, redCards } = stats;
  // Always render if at least one stat object is present (even 0-0 shows the icon)
  if (!corners && !yellowCards && !redCards) return null;

  return (
    <div className="live-stats-bar">
      {corners && (
        <span className="ls-item" title="Corners">
          <span className="ls-icon corner-icon">&#9873;</span>
          {corners.home}-{corners.away}
          <span className="ls-total">({corners.total})</span>
        </span>
      )}
      {yellowCards && (
        <span className="ls-item" title="Tarjetas amarillas">
          <span className="ls-icon yellow-card" />
          {yellowCards.home}-{yellowCards.away}
        </span>
      )}
      {redCards && (redCards.home > 0 || redCards.away > 0) && (
        <span className="ls-item" title="Tarjetas rojas">
          <span className="ls-icon red-card" />
          {redCards.home}-{redCards.away}
        </span>
      )}
    </div>
  );
}

// ===================== LAST 5 BLOCK =====================
// Shows last 5 results per team: result badge, score, opponent, corners, cards

function Last5Block({ homeLastFive, awayLastFive, homeName, awayName, homeLogo, awayLogo }) {
  const hasHome = Array.isArray(homeLastFive) && homeLastFive.length > 0;
  const hasAway = Array.isArray(awayLastFive) && awayLastFive.length > 0;
  if (!hasHome && !hasAway) return null;

  const renderTeam = (matches, teamName, teamLogo) => (
    <div className="l5-team">
      <div className="l5-team-header">
        <TeamLogo src={teamLogo} name={teamName} size={18} />
        <span className="l5-team-name">{teamName}</span>
      </div>
      {matches.map((m, i) => (
        <div key={i} className="l5-row">
          <span className={`l5-result ${(m.r || '').toLowerCase()}`}>{m.r || '?'}</span>
          <span className="l5-score">{m.gF ?? '?'}-{m.gA ?? '?'}</span>
          <span className="l5-vs">vs</span>
          {m.oL && <img src={m.oL} alt="" className="l5-opp-logo" />}
          <span className="l5-opp">{(m.op || '?').slice(0, 11)}</span>
          <span className="l5-stats">
            {m.c?.total != null && <span className="l5-stat-chip c">{m.c.total}&#9965;</span>}
            {m.y?.total != null && <span className="l5-stat-chip y">{m.y.total}&#128722;</span>}
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="l5-block">
      <div className="l5-title">Últimos 5 partidos</div>
      <div className="l5-grid">
        {hasHome && renderTeam(homeLastFive, homeName, homeLogo)}
        {hasAway && renderTeam(awayLastFive, awayName, awayLogo)}
      </div>
    </div>
  );
}

// ===================== STATS BLOCK =====================
// avg/max/min corners, cards, goals — combined + per team
// + goal timing highlights + player highlights

function calcStats(matches, field) {
  const vals = (matches || []).map(m => m[field]?.total).filter(v => v != null && !isNaN(v));
  if (vals.length === 0) return null;
  const avg = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  return { avg, max, min };
}

function calcGoals(matches) {
  const vals = (matches || []).map(m => (m.gF ?? 0) + (m.gA ?? 0)).filter(v => !isNaN(v));
  if (vals.length === 0) return null;
  const avg = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  return { avg, max, min };
}

function calcGoalsFor(matches) {
  const vals = (matches || []).map(m => m.gF).filter(v => v != null && !isNaN(v));
  if (vals.length === 0) return null;
  const avg = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  return { avg, max, min };
}

function StatRow({ label, st }) {
  if (!st) return null;
  return (
    <div className="sblk-row">
      <span className="sblk-label">{label}</span>
      <span className="sblk-val">Prom: <b>{st.avg}</b></span>
      <span className="sblk-val hi">Máx: <b>{st.max}</b></span>
      <span className="sblk-val lo">Mín: <b>{st.min}</b></span>
    </div>
  );
}

function StatsBlock({ homeLastFive, awayLastFive, homeName, awayName, goalTiming, playerHighlights }) {
  const allMatches = [...(homeLastFive || []), ...(awayLastFive || [])];
  const hotPeriods = goalTiming?.combined?.filter(p => p.probability > 85) || [];
  const scorers = playerHighlights?.scorers || [];
  const shooters = playerHighlights?.shooters || [];
  if (allMatches.length === 0 && hotPeriods.length === 0 && scorers.length === 0 && shooters.length === 0) return null;

  // Combined totals (treat each match once for combined, or use both perspectives)
  const homeCorners = calcStats(homeLastFive, 'c');
  const awayCorners = calcStats(awayLastFive, 'c');
  const homeCards = calcStats(homeLastFive, 'y');
  const awayCards = calcStats(awayLastFive, 'y');
  const homeGoals = calcGoals(homeLastFive);
  const awayGoals = calcGoals(awayLastFive);
  const homeGoalsFor = calcGoalsFor(homeLastFive);
  const awayGoalsFor = calcGoalsFor(awayLastFive);

  // Combined corners/cards/goals (average of both teams' averages)
  const combCorners = (homeCorners && awayCorners)
    ? { avg: +((homeCorners.avg + awayCorners.avg) / 2).toFixed(1), max: Math.max(homeCorners.max, awayCorners.max), min: Math.min(homeCorners.min, awayCorners.min) }
    : homeCorners || awayCorners;
  const combCards = (homeCards && awayCards)
    ? { avg: +((homeCards.avg + awayCards.avg) / 2).toFixed(1), max: Math.max(homeCards.max, awayCards.max), min: Math.min(homeCards.min, awayCards.min) }
    : homeCards || awayCards;
  const combGoals = (homeGoals && awayGoals)
    ? { avg: +((homeGoals.avg + awayGoals.avg) / 2).toFixed(1), max: Math.max(homeGoals.max, awayGoals.max), min: Math.min(homeGoals.min, awayGoals.min) }
    : homeGoals || awayGoals;

  return (
    <div className="sblk">
      <div className="sblk-title">Estadísticas últimos 5 partidos</div>

      {/* Corners */}
      {(combCorners || homeCorners || awayCorners) && (
        <div className="sblk-section">
          <div className="sblk-section-title">&#9965; Córners</div>
          <StatRow label="Total combinado" st={combCorners} />
          <StatRow label={homeName} st={homeCorners} />
          <StatRow label={awayName} st={awayCorners} />
        </div>
      )}

      {/* Cards */}
      {(combCards || homeCards || awayCards) && (
        <div className="sblk-section">
          <div className="sblk-section-title">&#128722; Tarjetas amarillas</div>
          <StatRow label="Total combinado" st={combCards} />
          <StatRow label={homeName} st={homeCards} />
          <StatRow label={awayName} st={awayCards} />
        </div>
      )}

      {/* Goals */}
      {(combGoals || homeGoals || awayGoals) && (
        <div className="sblk-section">
          <div className="sblk-section-title">&#9917; Goles totales</div>
          <StatRow label="Total combinado" st={combGoals} />
          <StatRow label={`${homeName} (anotados)`} st={homeGoalsFor} />
          <StatRow label={`${awayName} (anotados)`} st={awayGoalsFor} />
        </div>
      )}

      {/* Goal timing */}
      {hotPeriods.length > 0 && (
        <div className="sblk-section">
          <div className="sblk-section-title">&#9201; Periodos con más probabilidad de gol</div>
          <div className="sblk-timing">
            {hotPeriods.map((p, i) => (
              <span key={i} className="sblk-timing-chip">{p.period}&apos; — {cap(p.probability)}%</span>
            ))}
          </div>
        </div>
      )}

      {/* Player highlights */}
      {(scorers.length > 0 || shooters.length > 0) && (
        <div className="sblk-section">
          <div className="sblk-section-title">&#9733; Jugadores destacados</div>
          {scorers.slice(0, 3).map((p, i) => (
            <div key={i} className="sblk-player">
              <span className="sblk-player-name">{p.name}</span>
              <span className="sblk-player-team">{p.teamName}</span>
              <span className="sblk-player-stat">&#9917; {p.totalGoals} goles / 5 partidos</span>
            </div>
          ))}
          {shooters.slice(0, 2).map((p, i) => (
            <div key={i} className="sblk-player">
              <span className="sblk-player-name">{p.name}</span>
              <span className="sblk-player-team">{p.teamName}</span>
              <span className="sblk-player-stat">&#127919; {p.totalShots} remates / 5 partidos</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ========================== LIVE MATCH DETAILS ==========================

function LiveMatchDetails({ stats, homeTeam, awayTeam }) {
  if (!stats) return null;

  return (
    <div className="live-details">
      {/* Stats table */}
      <div className="live-stats-table">
        <div className="lst-header">
          <span className="lst-team-name">{homeTeam.name}</span>
          <span className="lst-label">Estadistica</span>
          <span className="lst-team-name">{awayTeam.name}</span>
        </div>
        {stats.corners && (
          <div className="lst-row">
            <span className="lst-val">{stats.corners.home}</span>
            <span className="lst-label">Corners</span>
            <span className="lst-val">{stats.corners.away}</span>
          </div>
        )}
        <div className="lst-row">
          <span className="lst-val">{stats.goals?.home ?? 0}</span>
          <span className="lst-label">Goles</span>
          <span className="lst-val">{stats.goals?.away ?? 0}</span>
        </div>
        {stats.yellowCards && (
          <div className="lst-row">
            <span className="lst-val"><span className="yellow-card-sm" /> {stats.yellowCards.home}</span>
            <span className="lst-label">Amarillas</span>
            <span className="lst-val">{stats.yellowCards.away} <span className="yellow-card-sm" /></span>
          </div>
        )}
        {stats.redCards && (stats.redCards.home > 0 || stats.redCards.away > 0) && (
          <div className="lst-row">
            <span className="lst-val"><span className="red-card-sm" /> {stats.redCards.home}</span>
            <span className="lst-label">Rojas</span>
            <span className="lst-val">{stats.redCards.away} <span className="red-card-sm" /></span>
          </div>
        )}
      </div>

      {/* Goal scorers */}
      {stats.goalScorers?.length > 0 && (
        <div className="live-scorers">
          <h4 className="live-section-title">Goles</h4>
          {stats.goalScorers.map((g, i) => (
            <div key={i} className={`live-scorer ${g.teamId === homeTeam.id ? 'home' : 'away'} ${g.type === 'Own Goal' ? 'og' : ''}`}>
              <span className="scorer-min">{g.minute}{g.extra ? `+${g.extra}` : ''}&apos;</span>
              <span className="scorer-type">
                {g.type === 'Penalty' ? '(P)' : g.type === 'Own Goal' ? '(AG)' : ''}
              </span>
              <span className="scorer-name">{g.player}</span>
            </div>
          ))}
        </div>
      )}

      {/* Missed penalties */}
      {stats.missedPenalties?.length > 0 && (
        <div className="live-scorers">
          <h4 className="live-section-title">Penales fallados</h4>
          {stats.missedPenalties.map((p, i) => (
            <div key={i} className={`live-scorer missed ${p.teamId === homeTeam.id ? 'home' : 'away'}`}>
              <span className="scorer-min">{p.minute}{p.extra ? `+${p.extra}` : ''}&apos;</span>
              <span className="scorer-name">{p.player}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ======================== SHARED ======================== */

function TeamLogo({ src, name, size = 24 }) {
  const [err, setErr] = useState(false);
  if (!src || err) {
    return (
      <div className="team-logo-fallback" style={{ width: size, height: size, fontSize: size * 0.4 }}>
        {(name || '?').slice(0, 2).toUpperCase()}
      </div>
    );
  }
  return <img src={src} alt={name} width={size} height={size} className="team-crest" onError={() => setErr(true)} />;
}

function getMinOdd(fixture, analyzedOdds) {
  const odds = analyzedOdds?.[fixture.fixture.id];
  if (!odds) return 0;
  return Math.min(odds.home || 99, odds.draw || 99, odds.away || 99);
}

/* ======================== API COUNTER (OWNER ONLY) ======================== */

function ApiCounter({ quota }) {
  const [liveQuota, setLiveQuota] = useState(quota);
  const [countdown, setCountdown] = useState('');

  // Poll quota every 30 seconds
  useEffect(() => {
    setLiveQuota(quota);
  }, [quota]);


  // Countdown to UTC midnight (API-Football daily reset)
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
      const diff = utcMidnight - now;
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setCountdown(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="api-counter">
      <div className="api-counter-row">
        <span className="api-counter-label">API Calls</span>
        <span className="api-counter-value">{liveQuota.used.toLocaleString()} hoy</span>
      </div>
      <div className="api-counter-row">
        <span className="api-counter-reset">Reset: {countdown}</span>
      </div>
    </div>
  );
}
