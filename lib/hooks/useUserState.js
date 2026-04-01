'use client';
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../components/providers';

/**
 * Central hook for per-user state: favorites, hidden fixtures, timezone.
 * All state is persisted in Supabase and survives page reloads.
 */
export function useUserState(currentDate) {
  const { user } = useAuth();
  const [favorites, setFavorites] = useState(new Set());
  const [hidden, setHidden] = useState(new Set());
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [loading, setLoading] = useState(true);

  // Load favorites and hidden for current date on mount
  useEffect(() => {
    if (!user) { setLoading(false); return; }

    async function load() {
      try {
        const [favRes, hidRes, tzRes] = await Promise.all([
          fetch('/api/favorites').then(r => r.json()),
          fetch(`/api/hidden?date=${currentDate}`).then(r => r.json()),
          fetch('/api/user/timezone').then(r => r.json()),
        ]);

        if (favRes.favorites) setFavorites(new Set(favRes.favorites));
        if (hidRes.hidden) setHidden(new Set(hidRes.hidden));
        if (tzRes.timezone) setTimezone(tzRes.timezone);
      } catch (err) {
        console.error('[useUserState] load failed:', err.message);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [user, currentDate]);

  const toggleFavorite = useCallback(async (fixtureId) => {
    if (!user) return;
    const isFav = favorites.has(fixtureId);

    // Optimistic update
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
      console.error('[useUserState:toggleFavorite]', err.message);
      // Revert on failure
      setFavorites(prev => {
        const next = new Set(prev);
        isFav ? next.add(fixtureId) : next.delete(fixtureId);
        return next;
      });
    }
  }, [user, favorites]);

  const hideFixture = useCallback(async (fixtureId, date) => {
    if (!user) return;

    setHidden(prev => new Set([...prev, fixtureId]));

    try {
      await fetch('/api/hidden', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId, date }),
      });
    } catch (err) {
      console.error('[useUserState:hideFixture]', err.message);
      setHidden(prev => { const next = new Set(prev); next.delete(fixtureId); return next; });
    }
  }, [user]);

  const unhideFixture = useCallback(async (fixtureId) => {
    if (!user) return;

    setHidden(prev => { const next = new Set(prev); next.delete(fixtureId); return next; });

    try {
      await fetch('/api/hidden', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId }),
      });
    } catch (err) {
      console.error('[useUserState:unhideFixture]', err.message);
      setHidden(prev => new Set([...prev, fixtureId]));
    }
  }, [user]);

  return {
    favorites,
    hidden,
    timezone,
    loading,
    toggleFavorite,
    hideFixture,
    unhideFixture,
    isFavorite: (id) => favorites.has(id),
    isHidden: (id) => hidden.has(id),
  };
}
