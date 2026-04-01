'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../../components/providers';
import { todayInTz } from '../timezone';

const LIVE_STATUSES = ['1H','2H','HT','ET','P','BT','LIVE'];

export function useDashboardData() {
  const { user } = useAuth();

  // Timezone — use user's detected timezone
  const [userTz, setUserTz] = useState('UTC');

  // Date navigation
  const [date, setDate] = useState('');

  const [fixtures, setFixtures] = useState([]);
  const [liveStats, setLiveStats] = useState({});
  const [analyzedData, setAnalyzedData] = useState({});
  const [analyzedIds, setAnalyzedIds] = useState([]);
  const [analyzedOdds, setAnalyzedOdds] = useState({});
  const [hidden, setHidden] = useState(new Set());
  const [favorites, setFavorites] = useState(new Set());
  const [quota, setQuota] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [batchStatus, setBatchStatus] = useState(null);

  const liveIntervalRef = useRef(null);
  const isMountedRef = useRef(true);

  // Detect timezone on mount
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    setUserTz(tz);
    setDate(todayInTz(tz));
  }, []);

  const loadFixtures = useCallback(async (targetDate, tz) => {
    if (!targetDate || !tz) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ date: targetDate, tz });
      const res = await fetch(`/api/fixtures?${params}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const data = await res.json();

      if (!isMountedRef.current) return;

      setFixtures(data.fixtures || []);
      setLiveStats(data.initialLiveStats || {});
      setAnalyzedData(data.analyzedData || {});
      setAnalyzedIds(data.analyzed || []);
      setAnalyzedOdds(data.analyzedOdds || {});
      setHidden(new Set(data.hidden || []));
      setFavorites(new Set(data.favorites || []));
      setQuota(data.quota || null);
      setBatchStatus(data.batchStatus || null);
    } catch (err) {
      if (isMountedRef.current) setError(err.message);
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, []);

  const refreshLive = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await fetch('/api/refresh-live', { method: 'POST', cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (isMountedRef.current && data.liveStats) {
        setLiveStats(prev => ({ ...prev, ...data.liveStats }));
      }
    } catch (err) {
      console.error('[useDashboardData:refreshLive]', err.message);
    } finally {
      if (isMountedRef.current) setRefreshing(false);
    }
  }, [refreshing]);

  // Load fixtures when date or tz changes
  useEffect(() => {
    if (date && userTz) loadFixtures(date, userTz);
  }, [date, userTz, loadFixtures]);

  // Auto-refresh live every 30 seconds
  useEffect(() => {
    const hasLive = fixtures.some(f => LIVE_STATUSES.includes(f.fixture?.status?.short));
    if (hasLive) {
      liveIntervalRef.current = setInterval(refreshLive, 30000);
    }
    return () => clearInterval(liveIntervalRef.current);
  }, [fixtures, refreshLive]);

  useEffect(() => { return () => { isMountedRef.current = false; }; }, []);

  // Date navigation
  function goToPrevDay() {
    const d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    setDate(d.toISOString().split('T')[0]);
  }

  function goToNextDay() {
    const d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    setDate(d.toISOString().split('T')[0]);
  }

  function goToToday() {
    setDate(todayInTz(userTz));
  }

  // Per-user state mutations
  const toggleFavorite = useCallback(async (fixtureId) => {
    if (!user) return;
    const isFav = favorites.has(fixtureId);
    setFavorites(prev => {
      const next = new Set(prev);
      isFav ? next.delete(fixtureId) : next.add(fixtureId);
      return next;
    });
    try {
      await fetch('/api/favorites', {
        method: isFav ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId }),
      });
    } catch (err) {
      console.error('[useDashboardData:toggleFavorite]', err.message);
      setFavorites(prev => {
        const next = new Set(prev);
        isFav ? next.add(fixtureId) : next.delete(fixtureId);
        return next;
      });
    }
  }, [user, favorites]);

  const hideFixture = useCallback(async (fixtureId, fixtureDate) => {
    if (!user) return;
    setHidden(prev => new Set([...prev, fixtureId]));
    try {
      await fetch('/api/hidden', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId, date: fixtureDate || date }),
      });
    } catch (err) {
      console.error('[useDashboardData:hideFixture]', err.message);
      setHidden(prev => { const next = new Set(prev); next.delete(fixtureId); return next; });
    }
  }, [user, date]);

  // Compute tab counts
  const liveFixtures = fixtures.filter(f => LIVE_STATUSES.includes(f.fixture?.status?.short));
  const finishedFixtures = fixtures.filter(f => ['FT','AET','PEN'].includes(f.fixture?.status?.short));
  const favoriteFixtures = fixtures.filter(f => favorites.has(f.fixture?.id));
  const visibleFixtures = fixtures.filter(f => !hidden.has(f.fixture?.id));

  const tabCounts = {
    all: visibleFixtures.length,
    live: liveFixtures.filter(f => !hidden.has(f.fixture?.id)).length,
    favorites: favoriteFixtures.filter(f => !hidden.has(f.fixture?.id)).length,
    finished: finishedFixtures.filter(f => !hidden.has(f.fixture?.id)).length,
  };

  return {
    date, userTz, fixtures, liveStats, analyzedData, analyzedIds, analyzedOdds,
    hidden, favorites, quota, loading, refreshing, error, batchStatus,
    tabCounts, liveFixtures, visibleFixtures,
    goToPrevDay, goToNextDay, goToToday,
    toggleFavorite, hideFixture, refreshLive,
    getFixturesByTab: (tab) => {
      let list = visibleFixtures;
      if (tab === 'live') list = list.filter(f => LIVE_STATUSES.includes(f.fixture?.status?.short));
      if (tab === 'favorites') list = list.filter(f => favorites.has(f.fixture?.id));
      if (tab === 'finished') list = list.filter(f => ['FT','AET','PEN'].includes(f.fixture?.status?.short));
      return list;
    },
  };
}
