import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { api, swrFetcher } from '@/lib/api';
import { useAccess } from '@/lib/access-context';
import { useWorkerEvent, useWorkerSocketState } from '@/lib/realtime/hooks';
import { buildBaseballApuestaDelDia, buildCustomBaseballCombinada } from '@/shared/baseball-combinada';
import { freeRecommendationForRail } from '@/shared/free-recommendation-rail';
import type { StatusFilter } from '@/components/dashboard/StatusDock';
import type { HiddenFixture } from '@/components/dashboard/HiddenMatches';

const isLive = (s?: string) => !!s && ['LIVE', 'IN', 'IN1', 'IN2', 'IN3', 'IN4', 'IN5', 'IN6', 'IN7', 'IN8', 'IN9'].includes(s);
const isFinished = (s?: string) => !!s && ['FT', 'AOT'].includes(s);
const isPostponed = (s?: string) => !!s && ['POST', 'CANC', 'INTR', 'ABD'].includes(s);
export const effectiveGameStatus = (game: any) => isFinished(game?.status?.short) ? game.status.short : (game?.liveResult?.status || game?.status?.short);

export function useBaseballDashboard({ date, userTz, statusFilter, leagueFilter, selectedMarkets }: { date: string; userTz: string; statusFilter: StatusFilter; leagueFilter: string; selectedMarkets: Record<string, Record<string, any>> }) {
  const { isFree } = useAccess();
  const wsState = useWorkerSocketState();
  const [error, setError] = useState('');
  const [liveOverrides, setLiveOverrides] = useState<Record<string, any>>({});
  const key = date ? `/api/baseball/fixtures?date=${date}&tz=${encodeURIComponent(userTz)}` : null;
  const { data: fxData, mutate, isLoading } = useSWR<any>(key, swrFetcher, {
    refreshInterval: (latest: any) => latest?.fixtures?.some((f: any) => !f.isAnalyzed) ? 30_000 : (wsState === 'connected' ? 0 : 300_000),
    revalidateOnFocus: wsState !== 'connected',
    dedupingInterval: 5000,
    keepPreviousData: true,
  });

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback((minimum = 2_000, spread = 28_000) => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => { refreshTimer.current = null; mutate(); }, minimum + Math.floor(Math.random() * spread));
  }, [mutate]);
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);

  // Estado pitch-by-pitch por WebSocket sobre los juegos de la jornada.
  useWorkerEvent('baseball-live', 'update', useCallback((data: any) => {
    if (!data?.games) return;
    setLiveOverrides((prev) => {
      const next = { ...prev };
      for (const s of data.games) {
        if (!s?.gamePk) continue;
        const override: any = {
          status: s.isFinal ? 'FT' : (s.isLive ? 'IN' : 'NS'),
          inning: s.inning ?? null,
          inning_half: s.inningHalf ? String(s.inningHalf).toLowerCase() : null,
          home_score: s.home?.runs ?? s.home?.score ?? null,
          away_score: s.away?.runs ?? s.away?.score ?? null,
          home_hits: s.home?.hits ?? null,
          away_hits: s.away?.hits ?? null,
          home_errors: s.home?.errors ?? null,
          away_errors: s.away?.errors ?? null,
          outs: s.outs, balls: s.balls, strikes: s.strikes, bases: s.bases,
          currentPitcher: s.currentPitcher, currentBatter: s.currentBatter, lastPlay: s.lastPlay,
        };
        if (s.home?.stats != null) override.home_stats = s.home.stats;
        if (s.away?.stats != null) override.away_stats = s.away.stats;
        if (s.innings != null) override.innings = s.innings;
        next[s.gamePk] = override;
      }
      return next;
    });
    if (data.games.some((g: any) => g?.isFinal)) scheduleRefresh(5_000, 45_000);
  }, [scheduleRefresh]));
  useWorkerEvent('baseball-analysis', 'ready', useCallback((payload: any) => { if (payload?.date === date) scheduleRefresh(); }, [date, scheduleRefresh]));

  const rawGames: any[] = fxData?.fixtures || [];
  const games = useMemo(() => Object.keys(liveOverrides).length === 0 ? rawGames : rawGames.map((g) => {
    const ov = liveOverrides[g.id];
    return ov ? { ...g, liveResult: { ...(g.liveResult || {}), ...ov } } : g;
  }), [rawGames, liveOverrides]);
  const hidden = useMemo(() => games.filter((g) => g.isHidden).map((g) => g.id), [games]);
  const favorites = useMemo(() => games.filter((g) => g.isFavorite).map((g) => g.id), [games]);
  const analyzed = useMemo(() => games.filter((g) => g.isAnalyzed).map((g) => g.id), [games]);
  const loading = isLoading && games.length === 0;

  const dismissMatch = useCallback(async (fixtureId: number) => {
    mutate((prev: any) => prev && ({ ...prev, fixtures: prev.fixtures.map((g: any) => g.id === fixtureId ? { ...g, isHidden: true } : g) }), { revalidate: false });
    try { await api.post('/api/baseball/hidden', { fixtureId, date, action: 'hide' }); }
    catch { mutate(); setError('No se pudo ocultar el partido — restaurado.'); }
  }, [mutate, date]);

  // Recuperar un partido ocultado por error (panel "Ocultos").
  const unhideMatch = useCallback(async (fixtureId: number) => {
    mutate((prev: any) => prev && ({ ...prev, fixtures: prev.fixtures.map((g: any) => g.id === fixtureId ? { ...g, isHidden: false } : g) }), { revalidate: false });
    try { await api.post('/api/baseball/hidden', { fixtureId, action: 'unhide' }); }
    catch { mutate(); setError('No se pudo recuperar el partido.'); }
  }, [mutate]);

  const toggleFavorite = useCallback(async (fixtureId: number) => {
    const isFav = favorites.includes(fixtureId);
    mutate((prev: any) => prev && ({ ...prev, fixtures: prev.fixtures.map((g: any) => g.id === fixtureId ? { ...g, isFavorite: !isFav } : g) }), { revalidate: false });
    try { await api.post('/api/baseball/favorites', { fixtureId, action: isFav ? 'remove' : 'add' }); }
    catch { mutate(); setError('No se pudo guardar el favorito — restaurado.'); }
  }, [favorites, mutate]);

  const hiddenFixtures = useMemo<HiddenFixture[]>(() => games.filter((g) => g.isHidden)
    .map((g) => ({ id: g.id, home: g.teams?.home?.name || '', away: g.teams?.away?.name || '', date: g.date })), [games]);

  const visible = useMemo(() => games.filter((g) => {
    if (hidden.includes(g.id)) return false;
    const s = effectiveGameStatus(g);
    if (isPostponed(s)) return false;
    if (statusFilter === 'live' && !isLive(s)) return false;
    if (statusFilter === 'upcoming' && s !== 'NS') return false;
    if (statusFilter === 'finished' && !isFinished(s)) return false;
    if (statusFilter === 'favoritos' && !favorites.includes(g.id)) return false;
    if (leagueFilter && String(g.league?.id) !== leagueFilter) return false;
    return true;
  }).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()), [games, hidden, statusFilter, leagueFilter, favorites]);

  const analyzedGames = useMemo(() => games.filter((g) => analyzed.includes(g.id) && !hidden.includes(g.id) && g.analysis), [games, analyzed, hidden]);

  const apuestaDelDia = useMemo(() => {
    if (!isFree) return buildBaseballApuestaDelDia(analyzedGames) || { selections: [], combinedProbability: 0 };
    const recommendations = analyzedGames.map((game) => freeRecommendationForRail({ sport: 'baseball', game, analysis: game.analysis, liveResult: game.liveResult })).filter((s: any) => s && !s.resultState.isFinal);
    const results = fxData?.date === date ? (fxData.freeDailyResults || []) : [];
    return { selections: [...recommendations, ...results], combinedProbability: 0 };
  }, [analyzedGames, isFree, fxData, date]);

  const counts = useMemo(() => ({
    all: games.filter((g) => !hidden.includes(g.id) && !isPostponed(effectiveGameStatus(g)) && (!leagueFilter || String(g.league?.id) === leagueFilter)).length,
    live: games.filter((g) => !hidden.includes(g.id) && isLive(effectiveGameStatus(g))).length,
    upcoming: games.filter((g) => !hidden.includes(g.id) && effectiveGameStatus(g) === 'NS').length,
    finished: games.filter((g) => !hidden.includes(g.id) && isFinished(effectiveGameStatus(g))).length,
    favorites: games.filter((g) => favorites.includes(g.id) && !hidden.includes(g.id)).length,
  }), [games, hidden, favorites, leagueFilter]);

  const leagues = useMemo(() => {
    const map = new Map<string, any>();
    for (const g of games) {
      if (hidden.includes(g.id) || !g.league?.id) continue;
      map.set(String(g.league.id), { id: g.league.id, name: g.league.name, country: g.country?.name, logo: g.league.logo });
    }
    return Array.from(map.values());
  }, [games, hidden]);

  const customCombinada = useMemo(() => buildCustomBaseballCombinada(selectedMarkets, Object.fromEntries(games.map((g) => [g.id, g]))), [selectedMarkets, games]);

  return { games, visible, analyzed, favorites, counts, leagues, loading, error, setError, apuestaDelDia, customCombinada, dismissMatch, unhideMatch, hiddenFixtures, toggleFavorite, refresh: () => mutate() };
}
