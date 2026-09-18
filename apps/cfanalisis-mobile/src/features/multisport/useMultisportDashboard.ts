import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import * as SecureStore from 'expo-secure-store';
import { api, swrFetcher } from '@/lib/api';
import { useAccess } from '@/lib/access-context';
import { useWorkerEvent, useWorkerSocketState } from '@/lib/realtime/hooks';
import { buildBaseballApuestaDelDia } from '@/shared/baseball-combinada';
import { freeRecommendationForRail } from '@/shared/free-recommendation-rail';
import { isMultisportFinal, isMultisportLive } from '@/lib/format';
import type { StatusFilter } from '@/components/dashboard/StatusDock';

const isGameLive = (game: any) => game.status?.isLive || isMultisportLive(game.status?.short);
const isGameFinal = (game: any) => game.status?.isFinal || isMultisportFinal(game.status?.short);

/** Baloncesto y fútbol americano: favoritos en el dispositivo (igual que la web). */
export function useMultisportDashboard({ sport, slug, date, userTz, statusFilter, leagueFilter, selectedMarkets }: { sport: 'basketball' | 'american_football'; slug: string; date: string; userTz: string; statusFilter: StatusFilter; leagueFilter: string; selectedMarkets: Record<string, Record<string, any>> }) {
  const { isFree } = useAccess();
  const wsState = useWorkerSocketState();
  const [favorites, setFavorites] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [enqueueing, setEnqueueing] = useState(false);
  const favKey = `cf_favorites_${sport}`;

  useEffect(() => {
    SecureStore.getItemAsync(favKey).then((stored) => {
      try { const parsed = JSON.parse(stored || '[]'); setFavorites(Array.isArray(parsed) ? parsed.map(String) : []); } catch { setFavorites([]); }
    }).catch(() => setFavorites([]));
  }, [favKey]);

  const key = date ? `/api/sports/${slug}/fixtures?date=${date}&tz=${encodeURIComponent(userTz)}` : null;
  const { data, error, isLoading, mutate } = useSWR<any>(key, swrFetcher, {
    refreshInterval: (latest: any) => latest?.fixtures?.some((f: any) => !f.isAnalyzed) ? 30_000 : (wsState === 'connected' ? 0 : 300_000),
    revalidateOnFocus: wsState !== 'connected',
    keepPreviousData: true,
    dedupingInterval: 15_000,
  });
  const currentData = data?.date === date ? data : null;
  const games: any[] = currentData?.fixtures || [];
  const competitions: any[] = currentData?.competitions || [];

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback((minimum = 2_000, spread = 28_000) => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => { refreshTimer.current = null; mutate(); }, minimum + Math.floor(Math.random() * spread));
  }, [mutate]);
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);

  useWorkerEvent(`${sport}-live`, 'update', useCallback((payload: any) => {
    if (!Array.isArray(payload?.games) || payload.date !== date) return;
    const updates = new Map(payload.games.map((g: any) => [String(g.id), g]));
    mutate((current: any) => current ? {
      ...current,
      fixtures: (current.fixtures || []).map((game: any) => {
        const update: any = updates.get(String(game.id));
        if (!update) return game;
        return {
          ...game,
          status: { ...game.status, ...update.status },
          scores: { home: { ...game.scores?.home, total: update.home?.score ?? game.scores?.home?.total }, away: { ...game.scores?.away, total: update.away?.score ?? game.scores?.away?.total } },
          periods: update.periods || game.periods,
        };
      }),
    } : current, { revalidate: false });
    if (payload.games.some((g: any) => g.status?.isFinal || g.status?.short === 'FT')) scheduleRefresh(5_000, 45_000);
  }, [date, mutate, scheduleRefresh]));
  useWorkerEvent(`${sport}-analysis`, 'ready', useCallback((payload: any) => { if (payload?.date === date) scheduleRefresh(); }, [date, scheduleRefresh]));

  const toggleFavorite = useCallback((gameId: string | number) => {
    setFavorites((current) => {
      const id = String(gameId);
      const next = current.includes(id) ? current.filter((v) => v !== id) : [...current, id];
      SecureStore.setItemAsync(favKey, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, [favKey]);

  const leagues = useMemo(() => competitions.map((c) => ({ id: c.id, name: c.name, country: c.country })), [competitions]);
  const leagueGames = useMemo(() => games.filter((g) => !leagueFilter || String(g.league?.id) === String(leagueFilter)), [games, leagueFilter]);
  const counts = useMemo(() => ({
    all: leagueGames.length,
    live: leagueGames.filter(isGameLive).length,
    upcoming: leagueGames.filter((g) => !isGameLive(g) && !isGameFinal(g)).length,
    finished: leagueGames.filter(isGameFinal).length,
    favorites: leagueGames.filter((g) => favorites.includes(String(g.id))).length,
  }), [favorites, leagueGames]);
  const visible = useMemo(() => leagueGames.filter((g) => {
    if (statusFilter === 'live') return isGameLive(g);
    if (statusFilter === 'upcoming') return !isGameLive(g) && !isGameFinal(g);
    if (statusFilter === 'finished') return isGameFinal(g);
    if (statusFilter === 'favoritos') return favorites.includes(String(g.id));
    return true;
  }).sort((a, b) => String(a.league?.name || '').localeCompare(String(b.league?.name || ''), 'es') || new Date(a.date).getTime() - new Date(b.date).getTime()), [favorites, leagueGames, statusFilter]);

  const combination = useMemo(() => {
    const selections = Object.entries(selectedMarkets).flatMap(([fixtureId, entries]) => Object.values(entries).slice(0, 1).map((entry: any) => ({ ...entry, fixtureId })));
    if (!selections.length) return null;
    const combinedOdd = selections.reduce((total, s: any) => total * (Number(s.odd) || 1), 1);
    const combinedProbability = selections.reduce((total, s: any) => total * (Number(s.rawProbability ?? s.probability) / 100), 1) * 100;
    return { selections, combinedOdd, combinedProbability: Math.round((combinedProbability + Number.EPSILON) * 100) / 100 };
  }, [selectedMarkets]);

  const pendingGames = useMemo(() => games.filter((g) => !g.isAnalyzed).length, [games]);
  const apuestaDelDia = useMemo(() => {
    if (!isFree) return buildBaseballApuestaDelDia(games.filter((g) => g.isAnalyzed && g.analysis)) || { selections: [], combinedProbability: 0 };
    const recommendations = games.map((game) => freeRecommendationForRail({ sport, game, analysis: game.analysis, liveResult: game.liveResult })).filter((s: any) => s && !s.resultState.isFinal);
    return { selections: [...recommendations, ...(currentData?.freeDailyResults || [])], combinedProbability: 0 };
  }, [games, isFree, currentData, sport]);

  const requestAnalysis = useCallback(async () => {
    setEnqueueing(true);
    setMessage('');
    try {
      await api.post(`/api/sports/${slug}/analyze`, { date, force: true });
      setMessage('La jornada se está preparando. Los resultados aparecerán automáticamente.');
      setTimeout(() => mutate(), 5000);
    } catch (requestError: any) {
      setMessage(requestError?.message || 'No se pudo preparar la jornada');
    } finally {
      setEnqueueing(false);
    }
  }, [slug, date, mutate]);

  const loading = !currentData && isLoading;
  return { games, visible, counts, leagues, favorites, toggleFavorite, combination, pendingGames, apuestaDelDia, requestAnalysis, enqueueing, message, loading, error: error ? 'No se pudo actualizar la jornada. Se muestran los últimos datos disponibles.' : '', refresh: () => mutate() };
}
