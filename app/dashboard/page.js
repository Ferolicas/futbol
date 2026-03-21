'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useUser, useClerk } from '@clerk/nextjs';
import { motion, AnimatePresence } from 'framer-motion';
import { FLAGS } from '../../lib/leagues';
import { usePusherEvent } from '../../lib/use-pusher';
import { selectBookmakerOdds, BOOKMAKER_LOGOS, TIMEZONE_TO_COUNTRY } from '../../lib/bookmakers';

function detectCountry() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TIMEZONE_TO_COUNTRY[tz] || 'default';
  } catch { return 'default'; }
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtTime = (d) => new Date(d).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
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
  const { user } = useUser();
  const { signOut } = useClerk();
  const [splash, setSplash] = useState(!_splashDone);
  const [splashFade, setSplashFade] = useState(false);
  const [tab, setTab] = useState('partidos');
  const [date, setDate] = useState(today());
  const [fixtures, setFixtures] = useState(_dashCache?.fixtures || []);
  const [loading, setLoading] = useState(!_dashCache);
  const [error, setError] = useState('');
  const [fromCache, setFromCache] = useState(_dashCache?.fromCache || false);
  const [quota, setQuota] = useState(_dashCache?.quota || { used: 0, remaining: 100, limit: 100 });
  const [hidden, setHidden] = useState(_dashCache?.hidden || []);
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
  // Custom combinada: { fixtureId: { marketId: marketObj } }
  const [selectedMarkets, setSelectedMarkets] = useState({});
  const [showApuesta, setShowApuesta] = useState(true);
  // Multiple saved combinadas
  const [savedCombinadas, setSavedCombinadas] = useState([]);
  const [savingComb, setSavingComb] = useState(false);
  // Live match stats (corners, cards, scorers)
  const [liveStats, setLiveStats] = useState(_dashCache?.liveStats || {});
  // Owner re-analyze state
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalyzeDone, setReanalyzeDone] = useState(false);
  const [reanalyzeProgress, setReanalyzeProgress] = useState(null);
  // Track Pusher activity (for debugging/diagnostics)
  const pusherLastUpdate = useRef(0);
  // Web push notifications
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSupported, setPushSupported] = useState(false);

  // Apply live data to fixtures — NEVER accepts a lower elapsed minute (prevents backwards jumps)
  const applyLiveUpdate = useCallback((prev, freshMatches) => {
    const updated = prev.map(f => {
      const fresh = freshMatches.find(m =>
        (m.fixtureId || m.fixture?.id) === f.fixture.id
      );
      if (!fresh) return f;

      const freshStatus = fresh.status || fresh.fixture?.status;
      const freshElapsed = freshStatus?.elapsed ?? fresh.elapsed;
      const currentElapsed = f.fixture.status.elapsed;

      // Never go backwards: if current elapsed is higher, keep it
      // (protects against stale data from any source)
      if (currentElapsed && freshElapsed && freshElapsed < currentElapsed) {
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

  const isOwner = user?.emailAddresses?.[0]?.emailAddress?.toLowerCase() === 'ferneyolicas@gmail.com';

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

  const loadFixtures = useCallback(async (d, { silent } = {}) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/fixtures?date=${d}`);
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
      // This is available immediately — no need to wait for cron or Pusher
      if (data.initialLiveStats && Object.keys(data.initialLiveStats).length > 0) {
        setLiveStats(prev => {
          const next = { ...prev, ...data.initialLiveStats };
          if (_dashCache) _dashCache.liveStats = next;
          return next;
        });
      }

      // Persist to module cache for instant back-navigation
      _dashCache = {
        fixtures: fx, analyzed: data.analyzed || [], analyzedOdds: data.analyzedOdds || {},
        analyzedData: data.analyzedData || {}, standings: data.standings || {},
        hidden: data.hidden || [], fromCache: data.fromCache || false,
        quota: data.quota || { used: 0, remaining: 100, limit: 100 },
        liveStats: data.initialLiveStats || {},
      };
      // Live updates come from Pusher — no /api/live polling needed
    } catch (e) {
      setError(e.message || 'Error de conexion');
    } finally {
      setLoading(false);
    }
  }, []);

  // On mount: if we have cached data (back-navigation), refresh silently in background
  useEffect(() => { loadFixtures(today(), { silent: !!_dashCache }); }, [loadFixtures]);

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
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;
        const vapidKey = process.env.NEXT_PUBLIC_VAPID_KEY;
        if (!vapidKey) return;
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
      }
    } catch (e) {
      console.error('[PUSH]', e);
    }
  };

  // === PUSHER REAL-TIME EVENTS ===
  // Only subscribe to Pusher for today's date — past dates are historical/fixed
  const isViewingToday = date === today();

  // Live scores: update fixtures and live stats in real-time (Pusher = sole source of truth)
  usePusherEvent(isViewingToday ? 'live-scores' : null, 'update', useCallback((data) => {
    if (!data?.matches) return;
    pusherLastUpdate.current = Date.now();
    // Update fixtures with anti-backwards protection
    setFixtures(prev => applyLiveUpdate(prev, data.matches));
    // Update live stats from Pusher data
    setLiveStats(prev => {
      const next = { ...prev };
      data.matches.forEach(m => {
        if (m.corners || m.yellowCards || m.redCards || m.goalScorers?.length) {
          const prev = next[m.fixtureId];
          next[m.fixtureId] = {
            ...prev,
            fixtureId: m.fixtureId,
            status: m.status,
            goals: m.goals,
            score: m.score,
            // Preserve corners from corners-cron if new value is 0 (live=all has no statistics)
            corners: m.corners?.total > 0 ? m.corners : (prev?.corners || m.corners),
            yellowCards: m.yellowCards,
            redCards: m.redCards,
            // Never overwrite with empty — API events are inconsistent per cycle
            goalScorers: m.goalScorers?.length > 0 ? m.goalScorers : (prev?.goalScorers || []),
            missedPenalties: m.missedPenalties?.length > 0 ? m.missedPenalties : (prev?.missedPenalties || []),
          };
        }
      });
      if (_dashCache) _dashCache.liveStats = next;
      return next;
    });
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

  // Corners update (every 45 min cron)
  usePusherEvent(isViewingToday ? 'live-scores' : null, 'corners-update', useCallback((data) => {
    if (!data?.matches) return;
    setLiveStats(prev => {
      const next = { ...prev };
      data.matches.forEach(m => {
        if (m.corners && next[m.fixtureId]) {
          next[m.fixtureId] = { ...next[m.fixtureId], corners: m.corners };
        }
      });
      if (_dashCache) _dashCache.liveStats = next;
      return next;
    });
  }, []));

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
    const d = new Date(date);
    d.setDate(d.getDate() + offset);
    const nd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    setDate(nd);
    setSelected(new Set());
    setSelectedMarkets({});
    setExpandedMatch(null);
    // Clear live stats when switching dates to prevent stale data from previous view
    setLiveStats({});
    pusherLastUpdate.current = 0;
    loadFixtures(nd);
  };

  const visible = fixtures.filter(f => {
    if (hidden.includes(f.fixture.id)) return false;
    const status = f.fixture.status.short;
    // Hide postponed/cancelled/suspended/abandoned matches
    if (isPostponed(status)) return false;
    if (statusFilter === 'live' && !isLive(status)) return false;
    if (statusFilter === 'upcoming' && status !== 'NS') return false;
    if (statusFilter === 'finished' && !isFinished(status)) return false;
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
    // Persist both: hide from Partidos + remove from Analizados
    try {
      await Promise.all([
        fetch('/api/hide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fixtureId }),
        }),
        fetch('/api/user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'remove-analyzed', data: { fixtureId } }),
        }),
      ]);
    } catch {}
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
                <span className="user-name">{user.firstName || user.emailAddresses?.[0]?.emailAddress?.split('@')[0]}</span>
                <button className="btn-signout" onClick={() => signOut({ redirectUrl: '/' })}>Salir</button>
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
            <button className="btn-reload" onClick={() => loadFixtures(date)} disabled={loading}>
              <span className={loading ? 'spin' : ''}>&#8635;</span>
            </button>
          </div>
        </motion.header>

        {/* OWNER: API counter */}
        {isOwner && <ApiCounter quota={quota} />}

        {/* CONTROLS: Date + Filters */}
        <div className="controls-row">
          <div className="date-nav">
            <button onClick={() => changeDate(-1)}>&#9664;</button>
            <span className="date-display">
              {new Date(date + 'T12:00:00').toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' })}
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
                {apuestaDelDia.selections.map((sel, i) => (
                  <div key={i} className={`apuesta-item ${sel.priority === 2 ? 'upcoming' : sel.priority === 1 ? 'live' : 'done'}`}>
                    <span className="apuesta-match">
                      {sel.priority === 2 && <span className="apuesta-status ns">&#9679;</span>}
                      {sel.priority === 1 && <span className="apuesta-status live">EN VIVO</span>}
                      {sel.priority === 0 && <span className="apuesta-status fin">FIN</span>}
                      {sel.matchName}
                    </span>
                    <span className="apuesta-mkt">{sel.name}</span>
                    <span className="apuesta-prob">{cap(sel.probability)}%</span>
                    <span className="apuesta-odd">{sel.odd.toFixed(2)}</span>
                  </div>
                ))}
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
                        idx={i}
                      />
                    );
                  }
                  return (
                    <MatchCard
                      key={m.fixture.id}
                      match={m}
                      isAnalyzed={false}
                      isSelected={selected.has(m.fixture.id)}
                      odds={analyzedOdds[m.fixture.id]}
                      standings={standings}
                      matchData={analyzedData[m.fixture.id]}
                      liveStats={liveStats[m.fixture.id]}
                      onSelect={() => toggleSelect(m.fixture.id)}
                      onHide={(e) => doHide(e, m.fixture.id)}
                      onView={() => router.push(`/dashboard/analisis/${m.fixture.id}`)}
                      idx={i}
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
                    idx={i}
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
          <span>{quota.used}/{quota.limit} API</span>
          <span>{fromCache ? 'Cache' : 'API'}</span>
          <span>{visible.length} partidos</span>
        </div>
      </div>
    </motion.div>
  );
}

/* ======================== MATCH CARD ======================== */

function MatchCard({ match, isAnalyzed, isSelected, odds, standings, matchData, liveStats, onSelect, onHide, onView, idx }) {
  const live = isLive(match.fixture.status.short);
  const finished = isFinished(match.fixture.status.short);
  const hasScore = live || finished;
  const meta = match.leagueMeta || {};
  const flag = FLAGS[meta.country] || '';
  const winProb = matchData?.calculatedProbabilities?.winner;
  const homePos = matchData?.homePosition || standings?.[match.teams.home.id];
  const awayPos = matchData?.awayPosition || standings?.[match.teams.away.id];

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
      <div className="mcard-top">
        <div className="mcard-league">
          {match.league.logo && <img src={match.league.logo} alt="" className="league-ico" />}
          <span>{flag} {match.league.name}</span>
        </div>
        <div className="mcard-time">
          {live ? (
            <span className="badge-live">
              <span className="dot-live" />
              <MatchTimer elapsed={match.fixture.status.elapsed} status={match.fixture.status.short} />
            </span>
          ) : finished ? (
            <span className="badge-ft">{statusText(match.fixture.status.short)}</span>
          ) : (
            <span className="badge-ns">{fmtTime(match.fixture.date)}</span>
          )}
        </div>
      </div>

      <div className="mcard-body">
        <div className="mcard-team">
          <div className="mcard-team-col">
            {homePos && <span className="pos-badge">{homePos}&#176;</span>}
            {winProb?.home != null && <span className="prob-badge">{winProb.home}%</span>}
            <TeamLogo src={match.teams.home.logo} name={match.teams.home.name} />
          </div>
          <span className="mcard-tname">{match.teams.home.name}</span>
        </div>
        <div className="mcard-score">
          {hasScore
            ? <span className={`score-num ${live ? 'live' : ''}`}>{match.goals.home} - {match.goals.away}</span>
            : <span className="score-vs">vs</span>
          }
        </div>
        <div className="mcard-team right">
          <div className="mcard-team-col">
            {awayPos && <span className="pos-badge">{awayPos}&#176;</span>}
            {winProb?.away != null && <span className="prob-badge">{winProb.away}%</span>}
            <TeamLogo src={match.teams.away.logo} name={match.teams.away.name} />
          </div>
          <span className="mcard-tname">{match.teams.away.name}</span>
        </div>
      </div>

      {/* Live stats bar: corners, cards */}
      {(live || finished) && liveStats && <LiveStatsBar stats={liveStats} />}

      {/* Goal scorers compact */}
      {(live || finished) && liveStats?.goalScorers?.length > 0 && (
        <div className="mcard-scorers">
          {liveStats.goalScorers.map((g, i) => (
            <span key={i} className={`scorer-chip ${g.type === 'Own Goal' ? 'og' : ''}`}>
              {g.minute}{g.extra ? `+${g.extra}` : ''}&apos; {g.player?.split(' ').pop()}
              {g.type === 'Penalty' ? ' (P)' : g.type === 'Own Goal' ? ' (AG)' : ''}
            </span>
          ))}
          {liveStats.missedPenalties?.map((p, i) => (
            <span key={`mp-${i}`} className="scorer-chip missed">
              {p.minute}&apos; {p.player?.split(' ').pop()} (Penal fallado)
            </span>
          ))}
        </div>
      )}

      {odds && (
        <div className="mcard-odds">
          <span className="odd-chip">{odds.home?.toFixed(2)}</span>
          <span className="odd-chip x">{odds.draw?.toFixed(2)}</span>
          <span className="odd-chip">{odds.away?.toFixed(2)}</span>
        </div>
      )}

      <div className="mcard-foot">
        {isAnalyzed ? (
          <span className="tag-done">&#10003; ANALIZADO</span>
        ) : (
          <label className="mcard-cb" onClick={e => e.stopPropagation()}>
            <input type="checkbox" checked={isSelected} onChange={onSelect} />
            <span className="cb-mark" />
          </label>
        )}
        <button className="btn-x" onClick={(e) => { e.stopPropagation(); onHide(e); }}>&#10005;</button>
      </div>
    </motion.div>
  );
}

/* ======================== ACCORDION CARD ======================== */

function AccordionCard({ match, data, odds, standings, liveStats, isExpanded, onToggle, selMarkets, onToggleMarket, onViewFull, onRemove, idx }) {
  const live = isLive(match.fixture.status.short);
  const finished = isFinished(match.fixture.status.short);
  const hasScore = live || finished;
  const meta = match.leagueMeta || {};
  const flag = FLAGS[meta.country] || '';
  const selCount = Object.keys(selMarkets).length;

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
    // Requisito #9: only show markets that have real odds (no odds = no display)
    return m
      .filter(x => x.probability >= 70 && x.probability <= 95 && x.odd && x.odd > 1)
      .sort((a, b) => b.probability - a.probability);
  }, [data, match]);

  return (
    <div className={`acc-card ${isExpanded ? 'open' : ''} stagger`} style={{ '--i': idx }}>
      {/* Header */}
      <div className="acc-head" onClick={onToggle}>
        <div className="mcard-top">
          <div className="mcard-league">
            {match.league.logo && <img src={match.league.logo} alt="" className="league-ico" />}
            <span>{flag} {match.league.name}</span>
          </div>
          <div className="mcard-time">
            {live ? <span className="badge-live"><span className="dot-live" /><MatchTimer elapsed={match.fixture.status.elapsed} status={match.fixture.status.short} /></span>
              : finished ? <span className="badge-ft">{statusText(match.fixture.status.short)}</span>
              : <span className="badge-ns">{fmtTime(match.fixture.date)}</span>}
          </div>
        </div>
        <div className="mcard-body">
          <div className="mcard-team">
            <TeamLogo src={match.teams.home.logo} name={match.teams.home.name} />
            <span className="mcard-tname">{match.teams.home.name}</span>
          </div>
          <div className="mcard-score">
            {hasScore
              ? <span className={`score-num ${live ? 'live' : ''}`}>{match.goals.home} - {match.goals.away}</span>
              : <span className="score-vs">vs</span>}
          </div>
          <div className="mcard-team right">
            <TeamLogo src={match.teams.away.logo} name={match.teams.away.name} />
            <span className="mcard-tname">{match.teams.away.name}</span>
          </div>
        </div>
        {/* Live stats bar in accordion header */}
        {(live || finished) && liveStats && <LiveStatsBar stats={liveStats} />}
        {/* Goal scorers compact — visible in header without opening accordion */}
        {(live || finished) && liveStats?.goalScorers?.length > 0 && (
          <div className="mcard-scorers">
            {liveStats.goalScorers.map((g, i) => (
              <span key={i} className={`scorer-chip ${g.type === 'Own Goal' ? 'og' : ''}`}>
                {g.minute}{g.extra ? `+${g.extra}` : ''}&apos; {g.player?.split(' ').pop()}
                {g.type === 'Penalty' ? ' (P)' : g.type === 'Own Goal' ? ' (AG)' : ''}
              </span>
            ))}
            {liveStats.missedPenalties?.map((p, i) => (
              <span key={`mp-${i}`} className="scorer-chip missed">
                {p.minute}&apos; {p.player?.split(' ').pop()} (Penal fallado)
              </span>
            ))}
          </div>
        )}
        {odds && (
          <div className="mcard-odds">
            <span className="odd-chip">{odds.home?.toFixed(2)}</span>
            <span className="odd-chip x">{odds.draw?.toFixed(2)}</span>
            <span className="odd-chip">{odds.away?.toFixed(2)}</span>
          </div>
        )}
        <div className="acc-indicator">
          {onRemove && (
            <button className="btn-x acc-rm" onClick={onRemove} title="Eliminar de analizados">&#10005;</button>
          )}
          {selCount > 0 && <span className="acc-sel-count">{selCount} sel.</span>}
          {data?.combinada && data.combinada.combinedOdd > 1 && (data.combinada.selections || []).some(s => s.odd && s.odd > 1) && (
            <span className="acc-mini">{cap(data.combinada.combinedProbability)}% | {data.combinada.combinedOdd}x</span>
          )}
          <span className={`chev-ico ${isExpanded ? 'up' : ''}`}>&#9662;</span>
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

              {/* Auto combinada — only show selections with real odds */}
              {(() => {
                const validSels = (data.combinada?.selections || []).filter(s => s.odd && s.odd > 1);
                if (validSels.length < 2) return null;
                const cOdd = validSels.reduce((a, s) => a * s.odd, 1);
                const cProb = validSels.reduce((a, s) => a + s.probability, 0) / validSels.length;
                return (
                  <div className="auto-comb">
                    <div className="auto-comb-head">
                      <span>&#127942; Combinada Auto</span>
                      <span className={`auto-comb-val ${cProb < 60 ? 'danger' : 'safe'}`}>
                        {cap(cProb)}% &middot; {cOdd.toFixed(2)}x
                      </span>
                    </div>
                    <div className="auto-comb-chips">
                      {validSels.map((s, i) => (
                        <span key={i} className="auto-chip">{s.name} <b>{cap(s.probability)}%</b> ({s.odd.toFixed(2)})</span>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Form summary */}
              {data.calculatedProbabilities?.homeForm && (
                <div className="form-mini">
                  <div className="form-mini-team">
                    <TeamLogo src={match.teams.home.logo} name={match.teams.home.name} size={18} />
                    <span className="form-mini-name">{match.teams.home.name}</span>
                    <span className="form-mini-pts">{data.calculatedProbabilities.homeForm.points}/{data.calculatedProbabilities.homeForm.maxPoints}</span>
                  </div>
                  <div className="form-matches">
                    {data.calculatedProbabilities.homeForm.results?.map((r, i) => (
                      <div key={i} className="form-match">
                        <span className={`fdot ${r.result.toLowerCase()}`}>{r.result}</span>
                        <span className="form-score">{r.goalsFor}-{r.goalsAgainst}</span>
                        <span className="form-vs">vs</span>
                        {r.opponentLogo && <img src={r.opponentLogo} alt="" className="form-opp-logo" />}
                        <span className="form-opp">{(r.opponent || '?').slice(0, 10)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="form-mini-team">
                    <TeamLogo src={match.teams.away.logo} name={match.teams.away.name} size={18} />
                    <span className="form-mini-name">{match.teams.away.name}</span>
                    <span className="form-mini-pts">{data.calculatedProbabilities.awayForm?.points}/{data.calculatedProbabilities.awayForm?.maxPoints}</span>
                  </div>
                  <div className="form-matches">
                    {data.calculatedProbabilities.awayForm?.results?.map((r, i) => (
                      <div key={i} className="form-match">
                        <span className={`fdot ${r.result.toLowerCase()}`}>{r.result}</span>
                        <span className="form-score">{r.goalsFor}-{r.goalsAgainst}</span>
                        <span className="form-vs">vs</span>
                        {r.opponentLogo && <img src={r.opponentLogo} alt="" className="form-opp-logo" />}
                        <span className="form-opp">{(r.opponent || '?').slice(0, 10)}</span>
                      </div>
                    ))}
                  </div>
                  {data.calculatedProbabilities.h2hSummary?.total > 0 && (
                    <div className="h2h-mini">
                      <span className="h2h-mini-n green">{data.calculatedProbabilities.h2hSummary.homeWins}</span>
                      <span className="h2h-mini-l">{match.teams.home.name.split(' ')[0]}</span>
                      <span className="h2h-mini-n yellow">{data.calculatedProbabilities.h2hSummary.draws}</span>
                      <span className="h2h-mini-l">Emp</span>
                      <span className="h2h-mini-n red">{data.calculatedProbabilities.h2hSummary.awayWins}</span>
                      <span className="h2h-mini-l">{match.teams.away.name.split(' ')[0]}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Selectable markets — only show if there are markets with real odds */}
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
                          <span className="mkt-odd">{mkt.odd.toFixed(2)}</span>
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

              {/* Per-team breakdown — internal stats only, no betting markets */}
              {data.calculatedProbabilities?.perTeam && (
                <div className="perteam-section">
                  <span className="perteam-disclaimer">Estadísticas internas</span>
                  {[
                    { key: 'home', name: match.teams.home.name, team: data.calculatedProbabilities.perTeam.home },
                    { key: 'away', name: match.teams.away.name, team: data.calculatedProbabilities.perTeam.away },
                  ].map(({ key, name, team }) => {
                    if (!team) return null;
                    const rows = [];
                    if (team.corners) {
                      Object.entries(team.corners).forEach(([k, v]) => {
                        if (v >= 70) {
                          const threshold = k.replace('over', '').replace('5', '.5');
                          rows.push({ label: `Corners ${name}: +${threshold}`, prob: v });
                        }
                      });
                    }
                    if (team.cards) {
                      Object.entries(team.cards).forEach(([k, v]) => {
                        if (v >= 70) {
                          const threshold = k.replace('over', '').replace('5', '.5');
                          rows.push({ label: `Tarjetas ${name}: +${threshold}`, prob: v });
                        }
                      });
                    }
                    if (team.goals) {
                      Object.entries(team.goals).forEach(([k, v]) => {
                        if (v >= 70) {
                          const threshold = k.replace('over', '').replace('5', '.5');
                          rows.push({ label: `Goles ${name}: +${threshold}`, prob: v });
                        }
                      });
                    }
                    if (rows.length === 0) return null;
                    return (
                      <div key={key} className="perteam-group">
                        {rows.sort((a, b) => b.prob - a.prob).map((r, i) => (
                          <div key={i} className="perteam-row">
                            <span className="perteam-label">{r.label}</span>
                            <span className={`perteam-prob ${r.prob >= 80 ? 'hi' : 'md'}`}>{r.prob}%</span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Goal timing */}
              {data.calculatedProbabilities?.goalTiming?.combined && (
                <div className="timing-section">
                  <h4 className="timing-title">Probabilidad de gol por periodo</h4>
                  <div className="timing-grid">
                    {data.calculatedProbabilities.goalTiming.combined
                      .filter(p => p.probability >= 70)
                      .map((p, i) => (
                        <div key={i} className={`timing-item ${p.highlight ? 'hot' : ''}`}>
                          <span className="timing-period">Gol {p.period} min</span>
                          <span className="timing-prob">{cap(p.probability)}%</span>
                        </div>
                      ))}
                  </div>
                  {data.calculatedProbabilities.goalTiming.combined.filter(p => p.probability >= 70).length === 0 && (
                    <span className="timing-none">Sin periodos con probabilidad alta (&ge;70%)</span>
                  )}
                </div>
              )}

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
  const hasData = corners || yellowCards || redCards;
  if (!hasData) return null;

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

  const pct = liveQuota.limit > 0 ? (liveQuota.used / liveQuota.limit) * 100 : 0;
  const danger = pct > 85;
  const warn = pct > 65;

  return (
    <div className={`api-counter ${danger ? 'danger' : warn ? 'warn' : ''}`}>
      <div className="api-counter-row">
        <span className="api-counter-label">API Calls</span>
        <span className="api-counter-value">{liveQuota.used.toLocaleString()} / {liveQuota.limit.toLocaleString()}</span>
      </div>
      <div className="api-counter-bar">
        <div className="api-counter-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <div className="api-counter-row">
        <span className="api-counter-remaining">{liveQuota.remaining.toLocaleString()} restantes</span>
        <span className="api-counter-reset">Reset: {countdown}</span>
      </div>
    </div>
  );
}
