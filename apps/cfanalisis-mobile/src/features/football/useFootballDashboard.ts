import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { api, swrFetcher } from '@/lib/api';
import { useAccess } from '@/lib/access-context';
import { useWorkerEvent, useWorkerSocketState } from '@/lib/realtime/hooks';
import { applyFixtureDelta, getFixtureLiveStats, getLiveStatsSnapshot, mergeLiveStats, replaceLiveStats } from '@/lib/realtime/fixture-store';
import { cap, isFinished, isLive, isPendingStatus, isPostponed } from '@/lib/format';
import { todayInTz } from '@/lib/timezone';
import { marketLabel } from '@/shared/market-labels';
import { isTelegramMarketAllowed } from '@/shared/telegram-daily-pick';
import { isFootballFrontendDailyPickEligible } from '@/shared/recommendation-policy';
import { leagueSelectionIncludes, normalizeLeagueSelection } from '@/shared/league-view-filter';
import { freeRecommendationForRail } from '@/shared/free-recommendation-rail';
import type { StatusFilter } from '@/components/dashboard/StatusDock';
import type { HiddenFixture } from '@/components/dashboard/HiddenMatches';

interface FixturesResponse {
  fixtures: any[];
  hidden?: number[];
  favorites?: number[];
  analyzed?: number[];
  analyzedOdds?: Record<string, any>;
  analyzedData?: Record<string, any>;
  freeDailyResults?: any[];
  historicalDailySelections?: any[];
  standings?: Record<string, number>;
  initialLiveStats?: Record<string, any>;
  batchStatus?: { started?: boolean; completed?: boolean; startedAt?: string | null } | null;
  error?: string;
}

/** Aplica marcador/estado en vivo a la lista sin retroceder nunca un final. */
function applyLiveUpdate(prev: any[], freshMatches: any[]) {
  if (!Array.isArray(freshMatches) || !freshMatches.length) return prev;
  const freshById = new Map(freshMatches.map((m) => [Number(m.fixtureId || m.fixture?.id), m]));
  let changed = false;
  const updated = prev.map((f) => {
    const fresh = freshById.get(Number(f.fixture.id));
    if (!fresh) return f;
    if (isFinished(f.fixture.status.short)) return f;
    const freshStatus = fresh.status || fresh.fixture?.status;
    const freshElapsed = freshStatus?.elapsed ?? fresh.elapsed;
    const currentElapsed = f.fixture.status.elapsed;
    if (isLive(f.fixture.status.short) && isPendingStatus(freshStatus?.short)) return f;
    if (currentElapsed && freshElapsed && freshElapsed < currentElapsed && !isFinished(freshStatus?.short)) return f;
    const nextStatus = freshStatus || f.fixture.status;
    const nextGoals = fresh.goals || f.goals;
    const nextScore = fresh.score || f.score;
    const same = nextStatus?.short === f.fixture.status?.short && nextStatus?.elapsed === f.fixture.status?.elapsed
      && nextGoals?.home === f.goals?.home && nextGoals?.away === f.goals?.away && JSON.stringify(nextScore) === JSON.stringify(f.score);
    if (same) return f;
    changed = true;
    return { ...f, fixture: { ...f.fixture, status: nextStatus }, goals: nextGoals, score: nextScore };
  });
  return changed ? updated : prev;
}

export function useFootballDashboard({ date, userTz, statusFilter }: { date: string; userTz: string; statusFilter: StatusFilter }) {
  const { isFree } = useAccess();
  const wsState = useWorkerSocketState();
  const isViewingToday = date === todayInTz(userTz);
  const isViewingPast = date < todayInTz(userTz);

  const [fixtures, setFixtures] = useState<any[]>([]);
  const [hidden, setHidden] = useState<number[]>([]);
  const [favorites, setFavorites] = useState<number[]>([]);
  const [analyzed, setAnalyzed] = useState<number[]>([]);
  const [analyzedOdds, setAnalyzedOdds] = useState<Record<string, any>>({});
  const [analyzedData, setAnalyzedData] = useState<Record<string, any>>({});
  const [freeDailyResults, setFreeDailyResults] = useState<any[]>([]);
  const [historicalDailySelections, setHistoricalDailySelections] = useState<any[]>([]);
  const [standings, setStandings] = useState<Record<string, number>>({});
  const [batchRunning, setBatchRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [leagueFilter, setLeagueFilter] = useState<string[] | null>(null);
  const [allLeagueIds, setAllLeagueIds] = useState<string[]>([]);
  const [leagueFilterReady, setLeagueFilterReady] = useState(false);
  const [leagueFilterSaving, setLeagueFilterSaving] = useState(false);
  const [savedCombinadas, setSavedCombinadas] = useState<any[]>([]);
  const [savingComb, setSavingComb] = useState(false);

  const clearLiveOnNextLoadRef = useRef(false);
  const lastEventRef = useRef(0);
  const liveFallbackInFlight = useRef<Promise<void> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leagueSaveQueue = useRef(Promise.resolve());
  const leagueSaveVersion = useRef(0);

  const key = date ? `/api/fixtures?date=${date}&tz=${encodeURIComponent(userTz)}` : null;
  const { mutate } = useSWR<FixturesResponse>(key, swrFetcher, {
    refreshInterval: isViewingToday && wsState !== 'connected' ? 300_000 : 0,
    revalidateOnFocus: isViewingToday && wsState !== 'connected',
    revalidateOnReconnect: true,
    dedupingInterval: 5000,
    keepPreviousData: true,
    onSuccess: (data) => applyFixturesData(data),
    onError: () => { setError('No pudimos cargar los partidos. Revisa tu conexión e inténtalo de nuevo.'); setLoading(false); },
  });

  useEffect(() => { if (key) setLoading(true); }, [key]);

  const applyFixturesData = useCallback((data: FixturesResponse | undefined) => {
    if (!data) { setLoading(false); return; }
    if (data.error && !data.fixtures?.length) { setError('No pudimos cargar los partidos. Reintenta en unos segundos.'); setLoading(false); return; }
    const clearLive = clearLiveOnNextLoadRef.current;
    clearLiveOnNextLoadRef.current = false;
    const fx = data.fixtures || [];
    const currentLive = getLiveStatsSnapshot();
    const withLive = Object.keys(currentLive).length
      ? fx.map((f) => {
          const live = currentLive[f.fixture?.id];
          if (live && isFinished(live.status?.short) && !isFinished(f.fixture?.status?.short)) {
            return { ...f, fixture: { ...f.fixture, status: live.status }, goals: live.goals || f.goals, score: live.score || f.score };
          }
          return f;
        })
      : fx;
    setFixtures(withLive);
    setHidden(data.hidden || []);
    setFavorites(data.favorites || []);
    setAnalyzed(data.analyzed || []);
    setAnalyzedOdds(data.analyzedOdds || {});
    setAnalyzedData(data.analyzedData || {});
    setFreeDailyResults(data.freeDailyResults || []);
    setHistoricalDailySelections(data.historicalDailySelections || []);
    setStandings(data.standings || {});
    setError(data.error ? 'Algunos datos podrían estar desactualizados.' : '');
    const batchAge = data.batchStatus?.startedAt ? Date.now() - new Date(data.batchStatus.startedAt).getTime() : 0;
    setBatchRunning(!!(data.batchStatus?.started && !data.batchStatus?.completed && batchAge < 600_000));
    if (data.initialLiveStats && Object.keys(data.initialLiveStats).length) {
      if (clearLive) replaceLiveStats(data.initialLiveStats); else mergeLiveStats(data.initialLiveStats);
    } else if (clearLive) replaceLiveStats({});
    setLoading(false);
  }, []);

  // Preferencia visual de ligas (GET/PUT /api/user/leagues).
  useEffect(() => {
    let cancelled = false;
    api.get<{ leagueIds: number[]; isCustom: boolean }>('/api/user/leagues')
      .then((body) => {
        if (cancelled) return;
        const ids = normalizeLeagueSelection(body.leagueIds) || [];
        setAllLeagueIds(ids);
        setLeagueFilter(body.isCustom ? ids : null);
      })
      .catch(() => { if (!cancelled) setLeagueFilter(null); })
      .finally(() => { if (!cancelled) setLeagueFilterReady(true); });
    return () => { cancelled = true; };
  }, []);

  const updateLeagueFilter = useCallback((next: string[] | null) => {
    const normalized = normalizeLeagueSelection(next);
    const version = ++leagueSaveVersion.current;
    setLeagueFilter(normalized);
    setLeagueFilterSaving(true);
    leagueSaveQueue.current = leagueSaveQueue.current
      .catch(() => {})
      .then(() => api.put('/api/user/leagues', { leagueIds: normalized === null ? null : normalized.map(Number) }))
      .then(() => {})
      .catch(() => { if (version === leagueSaveVersion.current) setError('El filtro se aplicó en pantalla, pero no pudo guardarse. Inténtalo de nuevo.'); })
      .finally(() => { if (version === leagueSaveVersion.current) setLeagueFilterSaving(false); });
  }, []);

  useEffect(() => {
    api.get<{ combinadas: any[] }>('/api/user?type=combinadas')
      .then((data) => { if (data.combinadas?.length) setSavedCombinadas(data.combinadas.map((c) => ({ ...c, id: c._id || c.id || Date.now() }))); })
      .catch(() => {});
  }, []);

  const scheduleRefresh = useCallback((minimum = 2_000, spread = 28_000) => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => { refreshTimer.current = null; mutate(); }, minimum + Math.floor(Math.random() * spread));
  }, [mutate]);
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);

  // Respaldo cache-only cuando el WebSocket no entrega eventos.
  const refreshLiveData = useCallback(() => {
    if (liveFallbackInFlight.current) return liveFallbackInFlight.current;
    const task = (async () => {
      try {
        const data = await api.get<{ liveStats?: Record<string, any>; viewDateLiveStats?: Record<string, any> | null }>(`/api/refresh-live?date=${encodeURIComponent(date)}`);
        for (const stats of [data.liveStats, data.viewDateLiveStats]) {
          if (!stats || typeof stats !== 'object') continue;
          mergeLiveStats(stats);
          setFixtures((prev) => applyLiveUpdate(prev, Object.values(stats)));
        }
      } catch {}
    })().finally(() => { liveFallbackInFlight.current = null; });
    liveFallbackInFlight.current = task;
    return task;
  }, [date]);

  const hasLive = useMemo(() => fixtures.some((f) => isLive(f.fixture.status.short)), [fixtures]);
  const wsConnectedAt = useRef(0);
  useEffect(() => { if (wsState === 'connected') wsConnectedAt.current = Date.now(); }, [wsState]);
  useEffect(() => {
    if (!hasLive || !isViewingToday) return;
    let lastRun = 0;
    const check = () => {
      const now = Date.now();
      const base = lastEventRef.current || wsConnectedAt.current || now;
      const stale = wsState !== 'connected' || now - base > 50_000;
      if (stale && now - lastRun >= 20_000) { lastRun = now; refreshLiveData(); }
    };
    const first = setTimeout(check, wsState === 'connected' ? 50_000 : 0);
    const poll = setInterval(check, 20_000);
    return () => { clearTimeout(first); clearInterval(poll); };
  }, [hasLive, isViewingToday, refreshLiveData, wsState]);

  // Realtime: deltas granulares por fixture + eventos de catálogo.
  useWorkerEvent(isViewingToday ? 'live-scores' : null, 'fixture-delta', useCallback((delta: any) => {
    if (!delta?.fixtureId || !delta?.changes) return;
    lastEventRef.current = Date.now();
    applyFixtureDelta(delta);
    setFixtures((prev) => applyLiveUpdate(prev, [{ fixtureId: delta.fixtureId, ...delta.changes }]));
    if (isFinished(delta.changes.status?.short)) scheduleRefresh(5_000, 45_000);
  }, [scheduleRefresh]));
  useWorkerEvent(isViewingToday ? 'live-scores' : null, 'update', useCallback((data: any) => {
    if (!Array.isArray(data?.matches)) return;
    lastEventRef.current = Date.now();
    mergeLiveStats(Object.fromEntries(data.matches.map((m: any) => [m.fixtureId, m])));
    setFixtures((prev) => applyLiveUpdate(prev, data.matches));
    if (data.matches.some((m: any) => isFinished(m.status?.short || m.fixture?.status?.short))) scheduleRefresh(5_000, 45_000);
  }, [scheduleRefresh]));
  useWorkerEvent(isViewingToday ? 'live-scores' : null, 'corners-update', useCallback((data: any) => {
    if (!Array.isArray(data?.matches)) return;
    mergeLiveStats(Object.fromEntries(data.matches.map((m: any) => [m.fixtureId, m])));
  }, []));
  useWorkerEvent(isViewingToday ? 'match-updates' : null, 'lineups-ready', useCallback(() => scheduleRefresh(), [scheduleRefresh]));
  useWorkerEvent(isViewingToday ? 'match-updates' : null, 'odds-ready', useCallback((data: any) => {
    if (data?.date === date && data?.fixtureIds?.length) scheduleRefresh();
  }, [date, scheduleRefresh]));
  useWorkerEvent(isViewingToday ? 'live-scores' : null, 'odds-update', useCallback((data: any) => {
    if (!data?.odds) return;
    setAnalyzedOdds((prev) => {
      const next = { ...prev };
      for (const [fid, odds] of Object.entries<any>(data.odds)) {
        if (odds.matchWinner) next[fid] = { ...(next[fid] || {}), home: odds.matchWinner.home, draw: odds.matchWinner.draw, away: odds.matchWinner.away };
      }
      return next;
    });
  }, []));
  useWorkerEvent(isViewingToday ? 'analysis' : null, 'batch-complete', useCallback((data: any) => {
    if (data?.date === date) { setBatchRunning(false); scheduleRefresh(); }
  }, [date, scheduleRefresh]));
  useEffect(() => {
    if (!batchRunning || wsState === 'connected') return;
    const poll = setInterval(() => scheduleRefresh(0, 30_000), 60_000);
    return () => clearInterval(poll);
  }, [batchRunning, wsState, scheduleRefresh]);

  const markDateChange = useCallback(() => { clearLiveOnNextLoadRef.current = true; lastEventRef.current = 0; }, []);

  // ── Acciones por usuario (optimistas con rollback) ─────────────────────
  const toggleFavorite = useCallback(async (fixtureId: number) => {
    const isFav = favorites.includes(fixtureId);
    setFavorites((prev) => isFav ? prev.filter((id) => id !== fixtureId) : [...prev, fixtureId]);
    try {
      if (isFav) await api.delete('/api/favorites', { fixtureId }); else await api.post('/api/favorites', { fixtureId });
    } catch {
      setFavorites((prev) => isFav ? [...prev, fixtureId] : prev.filter((id) => id !== fixtureId));
      setError('No se pudo guardar el favorito — restaurado.');
    }
  }, [favorites]);

  const dismissMatch = useCallback(async (fixtureId: number) => {
    const prevHidden = hidden;
    setHidden((prev) => prev.includes(fixtureId) ? prev : [...prev, fixtureId]);
    try {
      await api.post('/api/hidden', { fixtureId, date });
    } catch {
      setHidden(prevHidden);
      setError('No se pudo ocultar el partido — restaurado.');
    }
  }, [hidden, date]);

  // Recuperar un partido ocultado por error (panel "Ocultos"): optimista + rollback.
  const unhideMatch = useCallback(async (fixtureId: number) => {
    setHidden((prev) => prev.filter((id) => id !== fixtureId));
    try {
      await api.delete('/api/hidden', { fixtureId });
    } catch {
      setHidden((prev) => prev.includes(fixtureId) ? prev : [...prev, fixtureId]);
      setError('No se pudo recuperar el partido.');
    }
  }, []);

  const saveCombinada = useCallback(async (combination: any) => {
    if (!combination?.selections?.length) return;
    setSavingComb(true);
    const name = `Combinada ${savedCombinadas.length + 1} - ${new Date().toLocaleDateString('es')}`;
    const tempId = `tmp-${Date.now()}`;
    setSavedCombinadas((prev) => [...prev, { name, ...combination, id: tempId }]);
    try {
      const body = await api.post<{ success?: boolean; id?: string }>('/api/user', { type: 'save-combinada', data: { name, ...combination } });
      if (!body?.success) throw new Error('save-failed');
      if (body.id) setSavedCombinadas((prev) => prev.map((c) => (c.id === tempId ? { ...c, id: body.id } : c)));
    } catch {
      setSavedCombinadas((prev) => prev.filter((c) => c.id !== tempId));
      setError('No pudimos guardar la combinada. Reintenta en unos segundos.');
    } finally {
      setSavingComb(false);
    }
  }, [savedCombinadas.length]);

  const deleteSavedCombinada = useCallback(async (combId: string | number) => {
    const prevList = savedCombinadas;
    setSavedCombinadas((prev) => prev.filter((c) => c.id !== combId));
    try {
      await api.post('/api/user', { type: 'delete-combinada', data: { combinadaId: String(combId) } });
    } catch {
      setSavedCombinadas(prevList);
      setError('No pudimos eliminar la combinada. Reintenta en unos segundos.');
    }
  }, [savedCombinadas]);

  // ── Derivados ──────────────────────────────────────────────────────────
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const favoritesSet = useMemo(() => new Set(favorites), [favorites]);
  const analyzedSet = useMemo(() => new Set(analyzed), [analyzed]);
  const hiddenFixtures = useMemo<HiddenFixture[]>(() => fixtures.filter((f) => hiddenSet.has(f.fixture.id))
    .map((f) => ({ id: f.fixture.id, home: f.teams?.home?.name || '', away: f.teams?.away?.name || '', date: f.fixture.date })), [fixtures, hiddenSet]);
  const fixtureById = useMemo(() => new Map(fixtures.map((f) => [Number(f.fixture.id), f])), [fixtures]);

  const sorted = useMemo(() => fixtures.filter((f) => {
    if (hiddenSet.has(f.fixture.id)) return false;
    const status = f.fixture.status.short;
    if (isPostponed(status)) return false;
    if (statusFilter === 'live' && !isLive(status)) return false;
    if (statusFilter === 'upcoming' && status !== 'NS') return false;
    if (statusFilter === 'finished' && !isFinished(status)) return false;
    if (statusFilter === 'favoritos' && !favoritesSet.has(f.fixture.id)) return false;
    if (!leagueSelectionIncludes(leagueFilter, f.league.id)) return false;
    return true;
  }).sort((a, b) => new Date(a.fixture.date).getTime() - new Date(b.fixture.date).getTime()), [fixtures, hiddenSet, statusFilter, favoritesSet, leagueFilter]);

  const { counts, leagues } = useMemo(() => {
    let live = 0, upcoming = 0, finished = 0, favs = 0, all = 0;
    const leagueMap: Record<string, any> = {};
    for (const fixture of fixtures) {
      const id = fixture.fixture.id;
      if (hiddenSet.has(id)) continue;
      if (!leagueMap[fixture.league.id]) leagueMap[fixture.league.id] = { id: fixture.league.id, name: fixture.league.name, country: fixture.leagueMeta?.country || fixture.league.country, logo: fixture.league.logo };
      if (!leagueSelectionIncludes(leagueFilter, fixture.league.id)) continue;
      const status = fixture.fixture.status.short;
      if (isLive(status)) live++;
      if (status === 'NS') upcoming++;
      if (isFinished(status)) finished++;
      if (favoritesSet.has(id)) favs++;
      if (!isPostponed(status)) all++;
    }
    return { counts: { all, live, upcoming, finished, favorites: favs }, leagues: Object.values(leagueMap).sort((a, b) => a.name.localeCompare(b.name)) };
  }, [fixtures, hiddenSet, favoritesSet, leagueFilter]);

  const apuestaDelDia = useMemo(() => {
    if (isFree) {
      const recommendations = fixtures.map((game) => freeRecommendationForRail({ sport: 'football', game, analysis: analyzedData[game.fixture?.id], liveResult: getFixtureLiveStats(game.fixture?.id) as any }))
        .filter((selection: any) => selection && !selection.resultState.isFinal);
      return { selections: [...recommendations, ...freeDailyResults], combinedProbability: 0 };
    }
    if (isViewingPast) {
      if (!historicalDailySelections.length) return null;
      const selections = historicalDailySelections.map((s) => ({ ...s, probability: cap(s.rawProbability ?? s.probability), priority: 0 }));
      return { selections, combinedProbability: selections.reduce((sum, s) => sum + Number(s.rawProbability ?? s.probability), 0) / selections.length };
    }
    const all: any[] = [];
    Object.entries(analyzedData).forEach(([fid, data]) => {
      const fx = fixtureById.get(Number(fid));
      const status = fx?.fixture?.status?.short;
      let priority = 0;
      if (status === 'NS') priority = 2; else if (isLive(status)) priority = 1;
      if (!fx || isPostponed(status)) return;
      const homeTeam = fx.teams?.home?.name || data.homeTeam || '';
      const awayTeam = fx.teams?.away?.name || data.awayTeam || '';
      const selections: any[] = data?.combinada?.source === 'context-engine' ? (data.combinada.selectable || data.combinada.selections || []) : [];
      selections.forEach((sel) => {
        if (!isTelegramMarketAllowed(sel) || !isFootballFrontendDailyPickEligible(sel)) return;
        all.push({ ...sel, name: sel.scope === 'context' ? marketLabel(sel.id, { home: homeTeam, away: awayTeam }) : sel.name, probability: cap(sel.rawProbability ?? sel.probability), fixtureId: fid, matchName: `${homeTeam} vs ${awayTeam}`, priority });
      });
    });
    if (!all.length) return null;
    all.sort((a, b) => b.priority - a.priority || Number(b.rawProbability ?? b.probability) - Number(a.rawProbability ?? a.probability) || Number(b.expectedValue || 0) - Number(a.expectedValue || 0) || (b.odd || 0) - (a.odd || 0));
    return { selections: all, combinedProbability: +(all.reduce((sum, m) => sum + Number(m.rawProbability ?? m.probability), 0) / all.length).toFixed(2) };
  }, [analyzedData, fixtureById, isFree, isViewingPast, fixtures, freeDailyResults, historicalDailySelections]);

  return {
    fixtures, sorted, counts, leagues, analyzedSet, analyzedData, analyzedOdds, standings, favoritesSet,
    loading, error, setError, batchRunning, isViewingToday, isViewingPast,
    leagueFilter, allLeagueIds, leagueFilterReady, leagueFilterSaving, updateLeagueFilter,
    apuestaDelDia, savedCombinadas, savingComb, saveCombinada, deleteSavedCombinada,
    toggleFavorite, dismissMatch, unhideMatch, hiddenFixtures, refresh: () => mutate(), markDateChange,
  };
}
