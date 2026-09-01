'use client';

import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import useSWR from 'swr';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Flag,
  Layers3,
  Save,
  Scale,
  Sparkles,
  Target,
  Trash2,
  X,
} from 'lucide-react';
import { FLAGS } from '../../lib/leagues';
import { usePusherEvent } from '../../lib/use-pusher';
import { useWorkerSocketState } from '../../hooks/useWorkerSocket';
import { BOOKMAKER_LOGOS, TIMEZONE_TO_COUNTRY } from '../../lib/bookmakers';
import { todayInTz, getUserTz, fmtTimeInTz } from '../../lib/timezone';
import { marketLabel } from '../../lib/market-labels';
import { useIsIOS } from '../../lib/is-ios';
import { isTelegramMarketAllowed as isDailyPickMarketAllowed } from '../../lib/telegram-daily-pick';
import {
  isFootballFrontendDailyPickEligible,
  meetsFootballReliability,
} from '../../lib/recommendation-policy';
import { setAnalysisCache } from '../../lib/analysis-cache';
import { fetcher } from '../../lib/fetcher';
import BrandLogoMedia from '../../components/BrandLogoMedia';
import { useLiveStats } from './live-stats-context';
import { useSelectedMarkets } from './selected-markets-context';
import {
  DashboardDateStrip,
  DashboardStatusDock,
  LeaguePicker,
} from './components/DashboardFilters';
import DashboardBuffer from './components/DashboardBuffer';
import AnalysisFullModal from './components/AnalysisFullModal';
import { displayBettingText } from './utils/display-betting-text';
import { buildFootballProbabilityGroups } from './utils/probability-lines';
import FinalVerdictPanel from './components/FinalVerdictPanel';
import {
  leagueSelectionIncludes,
  normalizeLeagueSelection,
} from '../../lib/league-view-filter';

const AnalysisExperience = dynamic(
  () => import('./analisis/[id]/page').then((module) => module.AnalysisExperience),
  {
    ssr: false,
    loading: () => <DashboardBuffer compact />,
  },
);

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
const isCoveredCounter = (counter) => counter?.isReal === true || Number(counter?.total || 0) > 0;
const isPendingStatus = (s) => ['NS', 'TBD'].includes(s);
const isAwaitingOfficialResult = (match, now = Date.now()) => {
  if (!isPendingStatus(match?.fixture?.status?.short)) return false;
  const kickoff = new Date(match?.fixture?.date || 0).getTime();
  return Number.isFinite(kickoff) && kickoff > 0 && now > kickoff + 130 * 60 * 1000;
};
const statusText = (s) => ({
  NS: 'Proximo', '1H': '1T', '2H': '2T', HT: 'Entretiempo',
  FT: 'Final', ET: 'Extra', P: 'Penales', AET: 'Extra', PEN: 'Penales',
  SUSP: 'Suspendido', PST: 'Pospuesto', CANC: 'Cancelado',
}[s] || s);

// El motor y los rankings usan el valor crudo; esta función es exclusivamente
// visual y evita mostrar más de 95% o redondear 94.999% hacia 95%.
const cap = (v) => {
  const value = Math.max(0, Math.min(100, Number(v) || 0));
  if (value >= 95) return 95;
  return Math.floor((value + 1e-9) * 100) / 100;
};

// Splash-once-per-tab: el splash de bienvenida solo se muestra en la
// primera carga del tab. Las subsiguientes navegaciones (back desde
// detalle, cambio de fecha) lo saltan.
let _splashDone = false;
const EMPTY_MARKETS = Object.freeze({});

// _dashCache fue eliminado en favor de SWR. SWR mantiene su propia cache
// global por key — al volver desde /dashboard/analisis/[id] el cache hit
// instantaneo + revalidacion en background es lo mismo que daba _dashCache,
// sin tener que sincronizar a mano hidden/favorites/fixtures cada vez.

export default function Dashboard() {
  const router = useRouter();
  const [splash, setSplash] = useState(!_splashDone);
  const [splashFade, setSplashFade] = useState(false);
  // Banner de bienvenida tras checkout exitoso (ver efecto checkout=success).
  const [welcome, setWelcome] = useState(false);
  const [userTz, setUserTz] = useState('UTC'); // corrected on mount to user's real timezone
  // tzReady: hasta que detectamos la zona horaria real del cliente (en el mount)
  // NO disparamos el fetch de /api/fixtures. Asi evitamos el fetch inicial con
  // tz=UTC (placeholder) que luego se repetia con la tz correcta.
  const [tzReady, setTzReady] = useState(false);
  const [date, setDate] = useState(today());
  const [fixtures, setFixtures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [analyzed, setAnalyzed] = useState([]);
  const [analyzedOdds, setAnalyzedOdds] = useState({});
  const [analyzedData, setAnalyzedData] = useState({});
  const [standings, setStandings] = useState({});
  const [sortBy] = useState('time');
  const [statusFilter, setStatusFilter] = useState('all');
  // Filtro visual persistido: null=todas, []=ninguna, [ids]=personalizado.
  // No participa en getFixtures, análisis, cuotas ni workers.
  const [leagueFilter, setLeagueFilter] = useState(null);
  const [allLeagueIds, setAllLeagueIds] = useState([]);
  const [leagueFilterReady, setLeagueFilterReady] = useState(false);
  const [leagueFilterSaving, setLeagueFilterSaving] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [analyzing, setAnalyzing] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  // Accordion for Analizados
  const [expandedMatch, setExpandedMatch] = useState(null);
  // Custom combinada: shared via context so analisis/[id] page can add to it
  const { selectedMarkets, toggleMarket, setSelectedMarkets } = useSelectedMarkets();
  // Multiple saved combinadas
  const [savedCombinadas, setSavedCombinadas] = useState([]);
  const [savingComb, setSavingComb] = useState(false);
  // Live match stats — shared context: dashboard + detail page use the same data
  const { liveStats, setLiveStats, isPopulated } = useLiveStats();
  // El WebSocket es la fuente primaria; SWR y el snapshot Redis solo actúan
  // como respaldo conservador si la conexión cae o deja de entregar eventos.
  const wsState = useWorkerSocketState();
  // Estado de re-analyze (owner) eliminado junto con su botón del header.
  // Modal: ver análisis completo sin navegar
  const [analysisModalId, setAnalysisModalId] = useState(null);
  // Track Pusher activity (for debugging/diagnostics)
  const pusherLastUpdate = useRef(0);
  // Ref to always have the latest liveStats without adding it as a loadFixtures dependency
  const liveStatsRef = useRef(liveStats);
  // Senala que la proxima carga de fixtures debe REEMPLAZAR los live stats
  // (cambio de fecha) en vez de mergearlos (poll/focus de la misma fecha).
  const clearLiveOnNextLoadRef = useRef(false);
  // Puente para que el onSuccess de SWR llame a applyFixturesData (definida mas
  // abajo) sin problemas de orden de declaracion.
  const applyFixturesDataRef = useRef(null);
  const liveFallbackInFlightRef = useRef(null);
  const liveFallbackLastRunRef = useRef(0);
  const wsConnectedAtRef = useRef(0);
  // Web push notifications
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSupported, setPushSupported] = useState(false);
  const [pushError, setPushError] = useState(null);

  // Latest-value refs (FE-5): permiten que toggleSelect/toggleFavorite/dismissMatch
  // sean useCallback ESTABLES (sin leer estado que cambia por render). Mantienen viva
  // la memoización de MatchCard — sin esto, un memo simple se anularía porque los
  // handlers cambiarían de identidad en cada tick. Mismo patrón que liveStatsRef.
  const favoritesRef = useRef(favorites);
  const hiddenRef = useRef(hidden);
  const analyzedRef = useRef(analyzed);
  const selectedMarketsRef = useRef(selectedMarkets);
  const dateRef = useRef(date);
  const pushEnabledRef = useRef(pushEnabled);
  const pushSupportedRef = useRef(pushSupported);
  const subscribePushRef = useRef(null); // asignado tras definir subscribePush
  const leagueSaveQueueRef = useRef(Promise.resolve());
  const leagueSaveVersionRef = useRef(0);
  favoritesRef.current = favorites;
  hiddenRef.current = hidden;
  analyzedRef.current = analyzed;
  selectedMarketsRef.current = selectedMarkets;
  dateRef.current = date;
  pushEnabledRef.current = pushEnabled;
  pushSupportedRef.current = pushSupported;

  // Recuperar una sola vez la preferencia visual del usuario. Un perfil sin
  // valor usa "todas"; un arreglo vacío conserva explícitamente "ninguna".
  useEffect(() => {
    let cancelled = false;
    fetch('/api/user/leagues')
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        if (cancelled) return;
        const ids = normalizeLeagueSelection(body.leagueIds) || [];
        setAllLeagueIds(ids);
        setLeagueFilter(body.isCustom ? ids : null);
      })
      .catch((preferenceError) => {
        if (cancelled) return;
        console.error('[league-filter:load]', preferenceError.message);
        setLeagueFilter(null);
        setError('No pudimos recuperar tu filtro de ligas; se muestran todas.');
      })
      .finally(() => {
        if (!cancelled) setLeagueFilterReady(true);
      });
    return () => { cancelled = true; };
  }, []);

  // Escrituras serializadas: si se marcan cinco checks rápidamente, la última
  // selección siempre llega de última a PostgreSQL. keepalive permite terminar
  // el guardado aunque el usuario cierre o cambie de pantalla enseguida.
  const updateLeagueFilter = useCallback((nextValue) => {
    const normalized = normalizeLeagueSelection(nextValue);
    const version = ++leagueSaveVersionRef.current;
    setLeagueFilter(normalized);
    setLeagueFilterSaving(true);

    leagueSaveQueueRef.current = leagueSaveQueueRef.current
      .catch(() => {})
      .then(async () => {
        const response = await fetch('/api/user/leagues', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            leagueIds: normalized === null ? null : normalized.map(Number),
          }),
          keepalive: true,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      })
      .catch((saveError) => {
        console.error('[league-filter:save]', saveError.message);
        if (version === leagueSaveVersionRef.current) {
          setError('El filtro se aplicó en pantalla, pero no pudo guardarse. Inténtalo de nuevo.');
        }
      })
      .finally(() => {
        if (version === leagueSaveVersionRef.current) setLeagueFilterSaving(false);
      });
  }, []);

  // liveStats persiste a traves de SPA-navigation via su Context propio
  // (live-stats-context.js), no requiere reseed manual aqui.

  // Keep liveStatsRef in sync (used in loadFixtures to avoid stale closure)
  useEffect(() => {
    liveStatsRef.current = liveStats;
  }, [liveStats]);

  // Apply live data to fixtures — NEVER downgrade a finished match or go backwards in time
  const applyLiveUpdate = useCallback((prev, freshMatches) => {
    if (!Array.isArray(freshMatches) || freshMatches.length === 0) return prev;
    const FT = ['FT', 'AET', 'PEN'];
    const freshById = new Map(
      freshMatches.map(match => [Number(match.fixtureId || match.fixture?.id), match]),
    );
    let changed = false;
    const updated = prev.map(f => {
      const fresh = freshById.get(Number(f.fixture.id));
      if (!fresh) return f;

      // NEVER downgrade a finished match — FT is final
      if (FT.includes(f.fixture.status.short)) return f;

      const freshStatus = fresh.status || fresh.fixture?.status;
      const freshElapsed = freshStatus?.elapsed ?? fresh.elapsed;
      const currentElapsed = f.fixture.status.elapsed;

      // API-Football puede responder NS/TBD durante un instante en el detalle
      // aunque el feed global ya haya confirmado juego. La UI nunca debe borrar
      // un EN VIVO real por esa regresion transitoria.
      if (isLive(f.fixture.status.short) && isPendingStatus(freshStatus?.short)) return f;

      // Never go backwards in elapsed time
      if (currentElapsed && freshElapsed && freshElapsed < currentElapsed &&
          !FT.includes(freshStatus?.short)) {
        return f;
      }

      const nextStatus = freshStatus || f.fixture.status;
      const nextGoals = fresh.goals || f.goals;
      const nextScore = fresh.score || f.score;
      const statusUnchanged =
        nextStatus?.short === f.fixture.status?.short &&
        nextStatus?.elapsed === f.fixture.status?.elapsed &&
        nextStatus?.extra === f.fixture.status?.extra &&
        nextStatus?.long === f.fixture.status?.long;
      const goalsUnchanged =
        nextGoals?.home === f.goals?.home && nextGoals?.away === f.goals?.away;
      const scoreUnchanged = JSON.stringify(nextScore) === JSON.stringify(f.score);
      if (statusUnchanged && goalsUnchanged && scoreUnchanged) return f;

      changed = true;
      return {
        ...f,
        fixture: {
          ...f.fixture,
          status: nextStatus,
        },
        goals: nextGoals,
        score: nextScore,
      };
    });
    return changed ? updated : prev;
  }, []);

  // isOwner y handleReanalyze eliminados junto con el botón "Re-analizar" del header.

  // ─── SWR: ÚNICA fuente de /api/fixtures por (date, tz) ──────────────────
  // - El WebSocket es la fuente primaria; con conexión sana no se vuelve a
  //   descargar el payload completo en segundo plano.
  // - Si la conexión cae, SWR hace una revalidación conservadora cada 5 min.
  // - Dedup 5s para que varias llamadas a mutate() simultaneas no spameen.
  // - keepPreviousData=true para que al cambiar de fecha NO se vea vacio.
  // - La key es null mientras tzReady sea false → SWR no hace fetch hasta que
  //   conocemos la zona real del cliente (un solo fetch, con la tz correcta).
  const fixturesKey = useMemo(
    () => (tzReady && date) ? `/api/fixtures?date=${date}&tz=${encodeURIComponent(userTz)}` : null,
    [tzReady, date, userTz],
  );
  const isViewingToday = date === todayInTz(userTz);
  const { mutate: fixturesMutate } = useSWR(
    fixturesKey,
    fetcher,
    {
      refreshInterval: isViewingToday && wsState !== 'connected' ? 300_000 : 0,
      revalidateOnFocus: isViewingToday && wsState !== 'connected',
      revalidateOnReconnect: true,
      dedupingInterval: 5000,
      keepPreviousData: true,
      // Toda la hidratacion (carga inicial, cambio de fecha, poll de 60s y
      // focus) pasa por applyFixturesData → una sola ruta, un solo fetch.
      onSuccess: (data) => { applyFixturesDataRef.current?.(data); },
      onError: (err) => {
        console.error('[fixtures:swr] error:', err);
        setError('No pudimos cargar los partidos. Revisa tu conexión e inténtalo de nuevo.');
        setLoading(false);
      },
    },
  );

  // Skeleton al cargar por primera vez y al cambiar de fecha/tz (cambia la key
  // de SWR). El poll de 60s y el focus NO cambian la key → no parpadea skeleton.
  useEffect(() => {
    if (fixturesKey) setLoading(true);
  }, [fixturesKey]);

  // Hidratacion unificada desde la respuesta de /api/fixtures. Antes esta logica
  // estaba duplicada entre el onSuccess de SWR y un fetch manual en loadFixtures,
  // lo que disparaba /api/fixtures 2-3 veces por carga. Ahora es la unica ruta:
  // la usa el onSuccess de SWR para la carga inicial, el cambio de fecha, el
  // poll de 60s y el focus.
  const applyFixturesData = useCallback((data) => {
    if (!data) { setLoading(false); return; }
    if (data.error && !data.fixtures?.length) {
      console.error('[fixtures] error:', data.error);
      setError('No pudimos cargar los partidos. Reintenta en unos segundos.');
      setLoading(false);
      return;
    }
    // ¿reemplazar live stats (cambio de fecha) o mergear (misma fecha)?
    const clearLiveStats = clearLiveOnNextLoadRef.current;
    clearLiveOnNextLoadRef.current = false;

    const fx = data.fixtures || [];
    // Apply current liveStats on top of server data — prevents overwriting a FT
    // status that refreshLiveData already fixed in React state when the server
    // Redis cache hasn't caught up yet.
    const currentLive = liveStatsRef.current;
    const FT_SET = new Set(['FT', 'AET', 'PEN']);
    const fxWithLiveOverride = Object.keys(currentLive).length > 0
      ? fx.map(f => {
          const live = currentLive[f.fixture?.id];
          if (!live) return f;
          // Only upgrade to FT, never downgrade
          if (FT_SET.has(live.status?.short) && !FT_SET.has(f.fixture?.status?.short)) {
            return { ...f, fixture: { ...f.fixture, status: live.status }, goals: live.goals || f.goals, score: live.score || f.score };
          }
          return f;
        })
      : fx;
    setFixtures(fxWithLiveOverride);
    setHidden(data.hidden || []);
    setFavorites(data.favorites || []);
    setAnalyzed(data.analyzed || []);
    setAnalyzedOdds(data.analyzedOdds || {});
    setAnalyzedData(data.analyzedData || {});
    setStandings(data.standings || {});
    if (data.error) console.warn('[fixtures] degradado:', data.error);
    setError(data.error ? 'Algunos datos podrían estar desactualizados.' : '');

    // Track if daily analysis batch is still running (timeout after 10 min)
    const batchAge = data.batchStatus?.startedAt
      ? Date.now() - new Date(data.batchStatus.startedAt).getTime() : 0;
    setBatchRunning(!!(data.batchStatus?.started && !data.batchStatus?.completed && batchAge < 600000));

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
                corners: isCoveredCounter(fresh.corners) ? fresh.corners : existing.corners,
                yellowCards: isCoveredCounter(fresh.yellowCards) ? fresh.yellowCards : existing.yellowCards,
                redCards: isCoveredCounter(fresh.redCards) ? fresh.redCards : existing.redCards,
                goalScorers: fresh.goalScorers?.length > 0 ? fresh.goalScorers : existing.goalScorers,
                cardEvents: fresh.cardEvents?.length > 0 ? fresh.cardEvents : existing.cardEvents,
                missedPenalties: fresh.missedPenalties?.length > 0 ? fresh.missedPenalties : existing.missedPenalties,
              };
            } else if (!existing) {
              // Primera vez que vemos el partido (seed inicial) → snapshot del server.
              next[fid] = fresh;
            } else {
              // Partido EN VIVO con datos ya presentes (normalmente del WS, que es
              // la fuente de verdad en vivo y va por delante de este poll de 60s).
              // NO reemplazar en bloque: eso reseteaba los córners que el WS ya
              // avanzó (bug "frontend 0-0 / córner no actualiza"). El poll solo
              // rellena huecos y los córners NUNCA bajan (máximo por-lado).
              const ph = isCoveredCounter(existing.corners) ? existing.corners.home : 0;
              const pa = isCoveredCounter(existing.corners) ? existing.corners.away : 0;
              const fh = isCoveredCounter(fresh.corners) ? fresh.corners.home : 0;
              const fa = isCoveredCounter(fresh.corners) ? fresh.corners.away : 0;
              const ch = Math.max(ph, fh), ca = Math.max(pa, fa);
              next[fid] = {
                ...fresh,
                ...existing, // el WS (existing) gana sobre el snapshot del poll
                corners: isCoveredCounter(existing.corners) || isCoveredCounter(fresh.corners)
                  ? { home: ch, away: ca, total: ch + ca, isReal: true }
                  : (existing.corners || fresh.corners),
                goalScorers: existing.goalScorers?.length > 0 ? existing.goalScorers : (fresh.goalScorers || []),
                cardEvents: existing.cardEvents?.length > 0 ? existing.cardEvents : (fresh.cardEvents || []),
                missedPenalties: existing.missedPenalties?.length > 0 ? existing.missedPenalties : (fresh.missedPenalties || []),
              };
            }
          }
          return next;
        });
      }
    } else if (clearLiveStats) {
      setLiveStats({});
    }

    setLoading(false);
  }, [setLiveStats]);

  // Mantener el puente onSuccess→applyFixturesData siempre fresco (evita TDZ:
  // el onSuccess de SWR esta declarado antes que applyFixturesData).
  useEffect(() => { applyFixturesDataRef.current = applyFixturesData; }, [applyFixturesData]);

  // loadFixtures: revalida la fecha ACTUAL via SWR (un solo fetch, con dedup).
  // Ya NO hace su propio fetch. Para cambiar de fecha se usa setDate (changeDate),
  // que cambia la key de SWR y dispara el fetch de la nueva fecha.
  const loadFixtures = useCallback((_d, opts = {}) => {
    if (opts.clearLiveStats) clearLiveOnNextLoadRef.current = true;
    return fixturesMutate();
  }, [fixturesMutate]);

  // Fallback cache-only: lee el snapshot del worker en Redis. La ruta GET nunca
  // dispara proveedores externos y se deduplica para que solo exista una
  // petición en vuelo aunque coincidan varios chequeos.
  const refreshLiveData = useCallback((overrideDate) => {
    const sentDate = overrideDate || date;
    if (liveFallbackInFlightRef.current) return liveFallbackInFlightRef.current;
    const task = (async () => {
      try {
        const res = await fetch(`/api/refresh-live?date=${encodeURIComponent(sentDate)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (dateRef.current !== sentDate) return;
        const FT = ['FT', 'AET', 'PEN'];

        // Helper: merge live stats into state
        const mergeLiveStats = (statsObj) => {
          if (!statsObj || typeof statsObj !== 'object') return;
          setLiveStats(prev => {
            const next = { ...prev };
            let changed = false;
            for (const [fid, fresh] of Object.entries(statsObj)) {
              const existing = next[fid];
              let candidate;
              // If server says FT, always accept — this fixes stale "live" entries
              if (FT.includes(fresh.status?.short)) {
                candidate = {
                  ...(existing || {}),
                  ...fresh,
                  corners: isCoveredCounter(fresh.corners) ? fresh.corners : (existing?.corners || fresh.corners),
                  goalScorers: fresh.goalScorers?.length > 0 ? fresh.goalScorers : (existing?.goalScorers || []),
                  cardEvents: fresh.cardEvents?.length > 0 ? fresh.cardEvents : (existing?.cardEvents || []),
                  missedPenalties: fresh.missedPenalties?.length > 0 ? fresh.missedPenalties : (existing?.missedPenalties || []),
                };
              } else if (existing && FT.includes(existing.status?.short)) {
                // Existing is FT — only upgrade stats, never downgrade status
                candidate = {
                  ...existing,
                  corners: isCoveredCounter(fresh.corners) ? fresh.corners : existing.corners,
                  yellowCards: isCoveredCounter(fresh.yellowCards) ? fresh.yellowCards : existing.yellowCards,
                  redCards: isCoveredCounter(fresh.redCards) ? fresh.redCards : existing.redCards,
                  goalScorers: fresh.goalScorers?.length > 0 ? fresh.goalScorers : existing.goalScorers,
                  cardEvents: fresh.cardEvents?.length > 0 ? fresh.cardEvents : existing.cardEvents,
                  missedPenalties: fresh.missedPenalties?.length > 0 ? fresh.missedPenalties : existing.missedPenalties,
                };
              } else if (existing && isLive(existing.status?.short) && isPendingStatus(fresh.status?.short)) {
                // El snapshot de detalle puede parpadear NS mientras el feed
                // global sigue live. Conservar la evidencia ya observada.
                candidate = existing;
              } else {
                candidate = {
                  ...(existing || {}),
                  ...fresh,
                  corners: isCoveredCounter(fresh.corners) ? fresh.corners : (existing?.corners || fresh.corners),
                  goalScorers: fresh.goalScorers?.length > 0 ? fresh.goalScorers : (existing?.goalScorers || []),
                  missedPenalties: fresh.missedPenalties?.length > 0 ? fresh.missedPenalties : (existing?.missedPenalties || []),
                };
              }
              if (JSON.stringify(candidate) !== JSON.stringify(existing)) {
                next[fid] = candidate;
                changed = true;
              }
            }
            return changed ? next : prev;
          });
          setFixtures(prev => applyLiveUpdate(prev, Object.values(statsObj)));
        };

        if (data.liveStats && typeof data.liveStats === 'object') {
          mergeLiveStats(data.liveStats);
        }
        if (data.viewDateLiveStats && typeof data.viewDateLiveStats === 'object') {
          mergeLiveStats(data.viewDateLiveStats);
        }
      } catch {}
    })();
    const trackedTask = task.finally(() => {
      if (liveFallbackInFlightRef.current === trackedTask) {
        liveFallbackInFlightRef.current = null;
      }
    });
    liveFallbackInFlightRef.current = trackedTask;
    return trackedTask;
  }, [date, applyLiveUpdate]);

  // On mount ONLY: detect user timezone, set date to local today, load fixtures.
  // Empty deps on purpose — loadFixtures/refreshLiveData are callbacks that get
  // recreated whenever `date` changes. Including them here triggered the
  // "shows next day for 1s then reverts to today" bug because clicking the
  // arrow re-fired this effect which reset the date.
  useEffect(() => {
    const tz = getUserTz();
    setUserTz(tz);
    const localDate = todayInTz(tz);
    setDate(localDate);
    // Habilitar inmediatamente la carga principal. El worker y /api/fixtures ya
    // entregan el snapshot live; no bloquear el primer render con otra petición.
    setTzReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // F2 (Fase 2 — watchdog de frescura): mientras haya partidos en vivo, cada 20s
  // comprobamos cuánto hace del último evento WS recibido (pusherLastUpdate). Se
  // refresca si el WS está caído O "connected" pero medio-muerto (sin entregar:
  // ningún update en >40s). Con el WS sano (update cada ~20s) el watchdog NUNCA
  // dispara el fetch → cero polling redundante. Esto cierra el hueco donde la
  // tarjeta quedaba congelada aunque el push sí llegara (el WS estaba "connected"
  // pero no entregaba y el poll anterior se suprimía por wsState).
  const hasLiveFixtures = useMemo(
    () => fixtures.some(f => isLive(f.fixture.status.short)),
    [fixtures],
  );

  useEffect(() => {
    if (wsState === 'connected') wsConnectedAtRef.current = Date.now();
  }, [wsState]);

  useEffect(() => {
    if (!hasLiveFixtures || !isViewingToday) return;
    const STALE_MS = 50_000;
    const MIN_FALLBACK_GAP_MS = 20_000;
    const check = () => {
      const now = Date.now();
      const freshnessBase = pusherLastUpdate.current || wsConnectedAtRef.current || now;
      const stale = wsState !== 'connected' || now - freshnessBase > STALE_MS;
      if (stale && now - liveFallbackLastRunRef.current >= MIN_FALLBACK_GAP_MS) {
        liveFallbackLastRunRef.current = now;
        refreshLiveData();
      }
    };
    const firstCheck = setTimeout(check, wsState === 'connected' ? STALE_MS : 0);
    const poll = setInterval(check, 20000);
    return () => {
      clearTimeout(firstCheck);
      clearInterval(poll);
    };
  }, [hasLiveFixtures, isViewingToday, refreshLiveData, wsState]);

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

  // Bienvenida tras checkout exitoso: el PaymentModal vuelve a
  // /dashboard?checkout=success&plan=X. Mostramos un banner de confirmación
  // (mismo patrón visual .batch-banner ya existente — sin librería de toasts) y
  // limpiamos el query param para que no reaparezca al recargar.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') !== 'success') return;
    setWelcome(true);
    // Limpia checkout&plan de la URL sin recargar ni navegar → al refrescar no
    // reaparece el mensaje.
    params.delete('checkout');
    params.delete('plan');
    const qs = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    const t = setTimeout(() => setWelcome(false), 6000);
    return () => clearTimeout(t);
  }, []);

  // === WEB PUSH NOTIFICATIONS ===
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    setPushSupported(true);
    navigator.serviceWorker.register('/sw.js').then(reg => {
      reg.pushManager.getSubscription().then(sub => setPushEnabled(!!sub));
    }).catch(() => {});
  }, []);

  // Subscribe to push notifications. Reutilizable:
  //   - al marcar favorito (interactivo → muestra errores).
  //   - al abrir la app si el permiso ya está concedido ({ silent:true } → no
  //     molesta con mensajes; solo renueva en silencio).
  // Si ya existe suscripción la RE-ENVÍA al servidor (renovación: recupera las
  // que el servidor podó por 410, las que el navegador rotó con la app cerrada,
  // o las aprobadas hace mucho que se quedaron sin guardar).
  const subscribePush = useCallback(async (opts = {}) => {
    const silent = !!opts.silent;
    const fail = (msg) => { if (!silent) setPushError(msg); return false; };
    if (!pushSupported) return false;
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
        return fail('Permisos de notificación bloqueados. Habilítalos en los ajustes del navegador para este sitio.');
      }
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(existing),
        }).catch(() => {});
        setPushEnabled(true); setPushError(null); return true;
      }
      // En modo silencioso NO pedimos permiso (no hay gesto del usuario y no
      // queremos un prompt inesperado al abrir). Solo renovamos si ya estaba
      // concedido y por algún motivo no había suscripción.
      if (silent && (typeof Notification === 'undefined' || Notification.permission !== 'granted')) {
        return false;
      }
      const permission = silent ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted') {
        return fail('Activa los permisos de notificación en tu navegador');
      }
      const keyRes = await fetch('/api/push/subscribe', { method: 'GET' });
      const keyJson = await keyRes.json().catch(() => ({}));
      const vapidKey = keyJson.vapidPublicKey;
      if (!vapidKey) {
        return fail('Servidor sin VAPID configurado. Contacta al administrador.');
      }
      const padding = '='.repeat((4 - vapidKey.length % 4) % 4);
      const base64 = (vapidKey + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = window.atob(base64);
      const appServerKey = new Uint8Array([...raw].map(c => c.charCodeAt(0)));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey });
      const saveRes = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub),
      });
      if (!saveRes.ok) {
        const msg = await saveRes.json().catch(() => ({}));
        return fail(msg.error || 'No se pudo guardar la suscripción en el servidor');
      }
      setPushEnabled(true);
      setPushError(null);
      return true;
    } catch (e) {
      console.error('[PUSH]', e);
      return fail(e?.message ? `No se pudo activar: ${e.message}` : 'No se pudo activar las notificaciones');
    }
  }, [pushSupported]);
  subscribePushRef.current = subscribePush;

  // Renovación al abrir la app: si el permiso ya está concedido, garantiza que
  // el servidor tenga una suscripción fresca (segunda capa, junto al
  // 'pushsubscriptionchange' del service worker). Silencioso.
  useEffect(() => {
    if (!pushSupported) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    subscribePush({ silent: true }).catch(() => {});
  }, [pushSupported, subscribePush]);

  // handlePushToggle y handlePushTest eliminados: la campanita global desapareció.
  // Las notificaciones se manejan exclusivamente via toggleFavorite. El endpoint
  // /api/push/test sigue disponible para diagnóstico via consola si hace falta.

  // === PUSHER REAL-TIME EVENTS ===
  // Only subscribe to Pusher for today's date — past dates are historical/fixed
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

  // Las cuotas Bet365/Bwin se completan en fases prepartido. Al recibir una
  // actualización recargamos el análisis ya reconstruido (probabilidades y
  // reglas intactas; solo cambian cuotas/opciones disponibles).
  usePusherEvent(isViewingToday ? 'match-updates' : null, 'odds-ready', useCallback((data) => {
    if (data?.date === date && data?.fixtureIds?.length) loadFixtures(date);
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

  // Hand-off navigation: pre-populate the analysis cache with the data
  // the dashboard already has so /dashboard/analisis/[id] renders instantly.
  const goToAnalysis = useCallback((fixtureId, match) => {
    try {
      const fid = String(fixtureId);
      const cached = analyzedData[fid];
      if (cached && match) {
        setAnalysisCache(fid, {
          analysis: {
            ...cached,
            fixtureId: Number(fid),
            homeTeam: match.teams?.home?.name || cached.homeTeam,
            awayTeam: match.teams?.away?.name || cached.awayTeam,
            homeLogo: match.teams?.home?.logo || cached.homeLogo,
            awayLogo: match.teams?.away?.logo || cached.awayLogo,
            homeId:   match.teams?.home?.id   || cached.homeId,
            awayId:   match.teams?.away?.id   || cached.awayId,
            kickoff:  match.fixture?.date     || cached.kickoff,
            status:   match.fixture?.status   || cached.status,
            goals:    match.goals             || cached.goals,
            league:   match.league?.name      || cached.league,
            leagueId: match.league?.id        || cached.leagueId,
            leagueLogo: match.league?.logo    || cached.leagueLogo,
          },
        });
      }
    } catch {}
    router.push(`/dashboard/analisis/${fixtureId}`);
  }, [analyzedData, router]);

  const openAnalysisModal = useCallback((fixtureId, match) => {
    try {
      const fid = String(fixtureId);
      const cached = analyzedData[fid];
      if (cached && match) {
        setAnalysisCache(fid, {
          analysis: {
            ...cached,
            fixtureId: Number(fid),
            homeTeam: match.teams?.home?.name || cached.homeTeam,
            awayTeam: match.teams?.away?.name || cached.awayTeam,
            homeLogo: match.teams?.home?.logo || cached.homeLogo,
            awayLogo: match.teams?.away?.logo || cached.awayLogo,
            homeId:   match.teams?.home?.id   || cached.homeId,
            awayId:   match.teams?.away?.id   || cached.awayId,
            kickoff:  match.fixture?.date     || cached.kickoff,
            status:   match.fixture?.status   || cached.status,
            goals:    match.goals             || cached.goals,
            league:   match.league?.name      || cached.league,
            leagueId: match.league?.id        || cached.leagueId,
            leagueLogo: match.league?.logo    || cached.leagueLogo,
          },
        });
      }
    } catch {}
    setAnalysisModalId(fixtureId);
  }, [analyzedData]);

  // Precargar una sola vez el bundle del modal. Prefetchear 12 rutas completas
  // descargaba RSC/datos por partido y competía con imágenes y scroll inicial.
  useEffect(() => {
    const preload = () => {
      try { AnalysisExperience.preload?.(); } catch {}
    };
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(preload, { timeout: 1500 });
      return () => window.cancelIdleCallback?.(id);
    }
    const timer = setTimeout(preload, 250);
    return () => clearTimeout(timer);
  }, []);

  const selectDate = (nd) => {
    if (!nd || nd === date) return;
    setDate(nd);
    setSelected(new Set());
    setSelectedMarkets({});
    setExpandedMatch(null);
    // Don't clear liveStats here — el siguiente onSuccess los reemplaza
    // atomicamente (clearLiveOnNextLoad) para evitar flicker (empty → loaded).
    pusherLastUpdate.current = 0;
    clearLiveOnNextLoadRef.current = true;
    // setDate(nd) ya cambio la key de SWR → dispara un unico fetch de la nueva fecha.
  };

  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const favoritesSet = useMemo(() => new Set(favorites), [favorites]);
  const analyzedSet = useMemo(() => new Set(analyzed), [analyzed]);
  const fixtureById = useMemo(
    () => new Map(fixtures.map(fixture => [Number(fixture.fixture.id), fixture])),
    [fixtures],
  );

  const visible = useMemo(() => fixtures.filter(f => {
    if (hiddenSet.has(f.fixture.id)) return false;
    const status = f.fixture.status.short;
    if (isPostponed(status)) return false;
    if (statusFilter === 'live' && !isLive(status)) return false;
    if (statusFilter === 'upcoming' && status !== 'NS') return false;
    if (statusFilter === 'finished' && !isFinished(status)) return false;
    if (statusFilter === 'favoritos' && !favoritesSet.has(f.fixture.id)) return false;
    if (!leagueSelectionIncludes(leagueFilter, f.league.id)) return false;
    return true;
  }), [fixtures, hiddenSet, statusFilter, favoritesSet, leagueFilter]);

  const sorted = useMemo(() => [...visible].sort((a, b) => {
    if (sortBy === 'time') return new Date(a.fixture.date) - new Date(b.fixture.date);
    if (sortBy === 'odds') {
      const oddA = getMinOdd(a, analyzedOdds), oddB = getMinOdd(b, analyzedOdds);
      if (oddA === 0 && oddB === 0) return new Date(a.fixture.date) - new Date(b.fixture.date);
      if (oddA === 0) return 1;
      if (oddB === 0) return -1;
      return oddA - oddB;
    }
    if (sortBy === 'probability') {
      const aA = analyzedSet.has(a.fixture.id) ? 1 : 0;
      const bA = analyzedSet.has(b.fixture.id) ? 1 : 0;
      if (aA !== bA) return bA - aA;
      const aP = analyzedData[a.fixture.id]?.combinada?.combinedProbability || 0;
      const bP = analyzedData[b.fixture.id]?.combinada?.combinedProbability || 0;
      if (aP !== bP) return bP - aP;
      return new Date(a.fixture.date) - new Date(b.fixture.date);
    }
    return 0;
  }), [visible, sortBy, analyzedOdds, analyzedSet, analyzedData]);

  const toggleSelect = useCallback((fid) => {
    setSelected(prev => {
      const n = new Set(prev);
      n.has(fid) ? n.delete(fid) : n.add(fid);
      return n;
    });
  }, []);

  const toggleExpandedMatch = useCallback((fixtureId) => {
    setExpandedMatch(prev => (prev === fixtureId ? null : fixtureId));
  }, []);

  const toggleAccordionMarket = useCallback((fixtureId, market, matchName) => {
    toggleMarket(fixtureId, market, matchName);
  }, [toggleMarket]);


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
      const newAnalyzed = data.analyses?.filter(a => a.success)?.map(a => a.fixtureId) || [];
      setAnalyzed(prev => [...new Set([...prev, ...newAnalyzed])]);
      setSelected(new Set());
      loadFixtures(date);
      if (newAnalyzed.length > 0) setExpandedMatch(newAnalyzed[0]);
    } catch (e) {
      console.error('[analyzeSelected] error:', e);
      setError('No pudimos analizar ahora, reintenta en unos segundos.');
    } finally {
      setAnalyzing(false);
    }
  };

  // Unified dismiss: removes from both Partidos AND Analizados tabs.
  // Optimistic con rollback — si la persistencia falla, devolvemos la UI al
  // estado previo en vez de mentir al usuario (mismo patron que saveCombinada).
  const dismissMatch = useCallback(async (e, fixtureId) => {
    e.stopPropagation();
    // Snapshot ANTES de mutar para poder hacer rollback exacto.
    // Leemos los valores via refs (no estado directo) para que este handler
    // sea useCallback estable y no rompa la memoización de MatchCard (FE-5).
    // SWR mantiene su propia cache: ademas del rollback local mutamos la
    // entry de fixtures con revalidate=false (no relanza fetch — confiamos
    // en la respuesta del POST) y, si POST falla, revalidamos para
    // resincronizar con el servidor.
    const prevHidden = hiddenRef.current;
    const prevAnalyzed = analyzedRef.current;
    const prevSelectedMarkets = selectedMarketsRef.current;

    setHidden(prev => prev.includes(fixtureId) ? prev : [...prev, fixtureId]);
    setAnalyzed(prev => prev.filter(id => id !== fixtureId));
    setSelectedMarkets(prev => {
      const n = { ...prev };
      delete n[fixtureId];
      return n;
    });
    try {
      fixturesMutate(prev => prev && ({
        ...prev,
        hidden: [...(prev.hidden || []).filter(id => id !== fixtureId), fixtureId],
        analyzed: (prev.analyzed || []).filter(id => id !== fixtureId),
      }), { revalidate: false });
    } catch {}

    try {
      const res = await fetch('/api/hidden', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId, date: dateRef.current }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      console.error('[dismissMatch] rollback:', e.message);
      setHidden(prevHidden);
      setAnalyzed(prevAnalyzed);
      setSelectedMarkets(prevSelectedMarkets);
      // Forzar revalidacion para que SWR sincronice el rollback con el servidor.
      try { fixturesMutate(); } catch {}
      setError('No se pudo ocultar el partido — restaurado.');
    }
  }, [fixturesMutate, setSelectedMarkets]);

  // Toggle favorite — optimistic update + persist + rollback si falla.
  //
  // Al MARCAR favorito, las notificaciones push son AUTOMÁTICAS:
  //   - Si el permiso del navegador está 'default' → se pide ahora mismo.
  //   - Si está 'granted' y no hay sub aún → se crea y registra.
  //   - Si está 'denied' → mensaje claro al usuario (no podemos volver a
  //     pedir desde JS; debe ir a ajustes del navegador).
  //
  // Marcar favorito SIN push = no tendría sentido, por eso lo forzamos.
  // La campanita global fue eliminada — el favorito ES el toggle de alertas.
  const toggleFavorite = useCallback(async (e, fixtureId) => {
    e.stopPropagation();
    // Leemos favorites y el estado de push via refs (no estado directo) para
    // que el handler sea useCallback estable — si dependiera de `favorites`
    // cambiaría de identidad en cada toggle y re-renderizaría TODAS las
    // tarjetas, anulando la memoización de MatchCard (FE-5).
    const isFav = favoritesRef.current.includes(fixtureId);
    const prevFavorites = favoritesRef.current;

    setFavorites(prev => isFav ? prev.filter(id => id !== fixtureId) : [...prev, fixtureId]);
    try {
      fixturesMutate(prev => prev && ({
        ...prev,
        favorites: isFav
          ? (prev.favorites || []).filter(id => id !== fixtureId)
          : [...(prev.favorites || []), fixtureId],
      }), { revalidate: false });
    } catch {}

    try {
      const res = await fetch('/api/favorites', {
        method: isFav ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Al MARCAR favorito → asegurar suscripción push inmediatamente.
      if (!isFav && pushSupportedRef.current && typeof Notification !== 'undefined') {
        if (Notification.permission === 'denied') {
          setPushError('Las notificaciones están bloqueadas en tu navegador. Habilítalas en ajustes para recibir alertas de tus favoritos.');
        } else if (!pushEnabledRef.current) {
          // subscribePush() internamente pide permiso si está 'default'
          // y crea la subscription via service worker.
          subscribePushRef.current?.().catch(err => {
            console.error('[toggleFavorite] push subscribe failed:', err?.message);
          });
        }
      }
    } catch (e) {
      console.error('[toggleFavorite] rollback:', e.message);
      setFavorites(prevFavorites);
      try { fixturesMutate(); } catch {}
      setError('No se pudo guardar el favorito — restaurado.');
    }
  }, [fixturesMutate]);

  // Keep backward-compatible aliases
  const doHide = dismissMatch;
  // Save current combinada (optimistic con rollback si falla en backend)
  const saveCombinada = async () => {
    if (!customCombinada || customCombinada.selections.length === 0) return;
    setSavingComb(true);
    const name = `Combinada ${savedCombinadas.length + 1} - ${new Date().toLocaleDateString('es')}`;
    const tempId = `tmp-${Date.now()}`;
    const optimistic = { name, ...customCombinada, id: tempId };
    setSavedCombinadas(prev => [...prev, optimistic]);
    try {
      const res = await fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'save-combinada', data: { name, ...customCombinada } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.success) {
        // Rollback + mostrar error
        setSavedCombinadas(prev => prev.filter(c => c.id !== tempId));
        console.error('[saveCombinada] HTTP', res.status, body?.error);
        setError('No pudimos guardar la combinada. Reintenta en unos segundos.');
        return;
      }
      // Reemplazar id temporal por el id real del servidor
      if (body.id) {
        setSavedCombinadas(prev => prev.map(c => (c.id === tempId ? { ...c, id: body.id } : c)));
      }
    } catch (e) {
      setSavedCombinadas(prev => prev.filter(c => c.id !== tempId));
      console.error('[saveCombinada] error:', e);
      setError('No pudimos guardar la combinada. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
      setSavingComb(false);
    }
  };

  const deleteSavedCombinada = async (combId) => {
    const prevList = savedCombinadas;
    setSavedCombinadas(prev => prev.filter(c => c.id !== combId));
    try {
      const res = await fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'delete-combinada', data: { combinadaId: String(combId) } }),
      });
      if (!res.ok) {
        setSavedCombinadas(prevList); // rollback
        const body = await res.json().catch(() => ({}));
        console.error('[deleteSavedCombinada] HTTP', res.status, body?.error);
        setError('No pudimos eliminar la combinada. Reintenta en unos segundos.');
      }
    } catch (e) {
      setSavedCombinadas(prevList);
      console.error('[deleteSavedCombinada] error:', e);
      setError('No pudimos eliminar la combinada. Revisa tu conexión e inténtalo de nuevo.');
    }
  };

  const {
    liveCount,
    upcomingCount,
    finishedCount,
    favoriteCount,
    leagues,
    allVisibleCount,
  } = useMemo(() => {
    let liveTotal = 0;
    let upcomingTotal = 0;
    let finishedTotal = 0;
    let favoriteTotal = 0;
    let visibleTotal = 0;
    const leagueMap = {};

    for (const fixture of fixtures) {
      const fixtureId = fixture.fixture.id;
      if (hiddenSet.has(fixtureId)) continue;
      if (!leagueMap[fixture.league.id]) {
        leagueMap[fixture.league.id] = {
          id: fixture.league.id,
          name: fixture.league.name,
          country: fixture.leagueMeta?.country || fixture.league.country,
          logo: fixture.league.logo,
        };
      }
      if (!leagueSelectionIncludes(leagueFilter, fixture.league.id)) continue;
      const status = fixture.fixture.status.short;
      if (isLive(status)) liveTotal++;
      if (status === 'NS') upcomingTotal++;
      if (isFinished(status)) finishedTotal++;
      if (favoritesSet.has(fixtureId)) favoriteTotal++;
      if (!isPostponed(status)) {
        visibleTotal++;
      }
    }

    return {
      liveCount: liveTotal,
      upcomingCount: upcomingTotal,
      finishedCount: finishedTotal,
      favoriteCount: favoriteTotal,
      leagues: leagueMap,
      allVisibleCount: visibleTotal,
    };
  }, [fixtures, hiddenSet, favoritesSet, leagueFilter]);

  const apuestaDelDia = useMemo(() => {
    // Reglas:
    //  - Solo selecciones con probabilidad ≥75%, fiabilidad ≥90% y cuota real ≥1.20
    //  - SIN límite por partido: si un partido tiene 10 opciones que cumplen,
    //    se muestran las 10
    //  - Solo partidos próximos (NS) o en vivo — los finalizados desaparecen
    //  - Orden: NS > en vivo, dentro de cada grupo prob desc
    //  - El ranking usa la probabilidad cruda; la UI muestra máximo 95%
    const all = [];

    Object.entries(analyzedData).forEach(([fid, data]) => {
      const fx = fixtureById.get(Number(fid));
      const status = fx?.fixture?.status?.short;
      let priority = 0;
      if (status === 'NS') priority = 2;
      else if (isLive(status)) priority = 1;
      // Filtrar finalizados (priority 0 = FT/AET/PEN/etc o fixture no presente).
      if (priority === 0) return;
      const mn = fx ? `${fx.teams.home.name} vs ${fx.teams.away.name}` : `${data.homeTeam || '?'} vs ${data.awayTeam || '?'}`;
      const homeTeam = fx?.teams?.home?.name || data.homeTeam || '';
      const awayTeam = fx?.teams?.away?.name || data.awayTeam || '';

      // selectable contiene todas las líneas calculadas desde 70%; leer solo
      // selections impediría que el baremo visual de 75% tuviera efecto,
      // porque ese subconjunto nace en 80%. La frontera pública ya recupera y
      // exige la fiabilidad real >=90% también para caches v20.
      const isEngine = data?.combinada?.source === 'context-engine';
      const selections = isEngine
        ? (data.combinada.selectable || data.combinada.selections || [])
        : [];

      selections.forEach(sel => {
        if (!isDailyPickMarketAllowed(sel)) return;
        if (!isFootballFrontendDailyPickEligible(sel)) return;
        all.push({
          ...sel,
          // Selecciones del motor traen el market_key como id; traducir a nombre
          // legible (cubre también combinadas cacheadas con la clave cruda).
          name: sel.scope === 'context' ? marketLabel(sel.id, { home: homeTeam, away: awayTeam }) : sel.name,
          probability: cap(sel.rawProbability ?? sel.probability),
          fixtureId: fid,
          matchName: mn,
          homeTeam,
          awayTeam,
          priority,
          matchTime: fx ? new Date(fx.fixture.date) : null,
        });
      });
    });

    if (all.length === 0) return null;

    // Orden: priority desc (NS primero), después prob desc, después cuota desc
    all.sort((a, b) =>
      b.priority - a.priority ||
      Number(b.rawProbability ?? b.probability) - Number(a.rawProbability ?? a.probability) ||
      (b.odd || 0) - (a.odd || 0)
    );

    const combinedProbability = all.reduce((acc, m) => acc + Number(m.rawProbability ?? m.probability), 0) / all.length;

    // “Apuesta del día” es un catálogo ordenado, no un cupón combinable: puede
    // contener varias líneas del mismo partido, incluso correlacionadas o
    // incompatibles entre sí. Multiplicar todas sus cuotas producía cifras
    // falsas como 1e+28. Las cuotas válidas se muestran individualmente en
    // cada selección; solo la combinada construida por el usuario tiene total.
    return {
      selections: all,
      combinedProbability: +combinedProbability.toFixed(2),
    };
  }, [analyzedData, fixtureById]);

  const customCombinada = useMemo(() => {
    const all = [];
    Object.entries(selectedMarkets).forEach(([fid, markets]) => {
      Object.values(markets).forEach(m => all.push({ ...m, fixtureId: fid }));
    });
    if (all.length === 0) return null;
    const co = all.reduce((a, m) => m.odd ? a * m.odd : a, 1);
    const cp = all.reduce((a, m) => a * (Number(m.rawProbability ?? m.probability) / 100), 1) * 100;
    return { selections: all, combinedOdd: +co.toFixed(2), combinedProbability: +cp.toFixed(2), highRisk: cp < 60 };
  }, [selectedMarkets]);

  const totalSel = useMemo(
    () => Object.values(selectedMarkets).reduce((a, m) => a + Object.keys(m).length, 0),
    [selectedMarkets],
  );

  // Solo se montan las filas próximas al viewport. Incluso con 400 partidos o
  // más, el DOM conserva aproximadamente 8–12 tarjetas; la altura total sigue
  // siendo desplazable y cada fila dinámica se mide al abrirse.
  // En iOS no: allí la lista va en flujo normal y virtualiza el navegador con
  // `content-visibility: auto` (ver el render de .match-list).
  const isIOS = useIsIOS();
  const matchListRef = useRef(null);
  const [matchListOffset, setMatchListOffset] = useState(0);
  const matchVirtualizer = useWindowVirtualizer({
    // En iOS la lista va sin ventana JS (ver el render), así que el
    // virtualizador se queda a cero y no mide ni posiciona nada.
    count: !loading && !isIOS ? sorted.length : 0,
    estimateSize: () => 310,
    overscan: 5,
    scrollMargin: matchListOffset,
    getItemKey: index => sorted[index]?.fixture.id ?? index,
    // Al abrir una tarjeta su altura crece. Mantener fijo el scroll actual
    // evita que el virtualizador "compense" el cambio y saque la fila pulsada
    // del viewport antes de que React termine de pintarla.
    //
    // OJO: hoy esto no hace nada. virtual-core 3.17.7 lee la propiedad en la
    // instancia (`this.shouldAdjustScrollPositionOnItemSizeChange`) y nunca la
    // copia desde las opciones, así que el callback jamás se consulta y manda
    // el comportamiento por defecto de la librería. Se deja puesto porque
    // declara la intención y volverá a aplicarse cuando la librería lo lea
    // desde `options`; si se necesita ya, hay que asignarlo sobre la instancia.
    shouldAdjustScrollPositionOnItemSizeChange: () => false,
  });

  useEffect(() => {
    if (splash || loading || !matchListRef.current) return;
    const updateOffset = () => {
      if (!matchListRef.current) return;
      const next = matchListRef.current.getBoundingClientRect().top + window.scrollY;
      setMatchListOffset(prev => (Math.abs(prev - next) > 1 ? next : prev));
    };
    const frame = requestAnimationFrame(updateOffset);
    window.addEventListener('resize', updateOffset, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', updateOffset);
    };
  }, [
    splash,
    loading,
    apuestaDelDia?.selections?.length,
    batchRunning,
    error,
    welcome,
    pushError,
    sorted.length,
  ]);

  // La tarjeta es la misma con y sin ventana JS; solo cambia quién la envuelve.
  const renderMatchCard = (m) => (analyzedSet.has(m.fixture.id) ? (
    <AccordionCard
      match={m}
      data={analyzedData[m.fixture.id]}
      odds={analyzedOdds[m.fixture.id]}
      standings={standings}
      liveStats={liveStats[m.fixture.id]}
      isExpanded={expandedMatch === m.fixture.id}
      onToggle={toggleExpandedMatch}
      selMarkets={selectedMarkets[m.fixture.id] || EMPTY_MARKETS}
      onToggleMarket={toggleAccordionMarket}
      onViewFull={openAnalysisModal}
      onRemove={dismissMatch}
      isFavorite={favoritesSet.has(m.fixture.id)}
      onFavorite={toggleFavorite}
      userTz={userTz}
    />
  ) : (
    <MatchCard
      match={m}
      isAnalyzed={false}
      isSelected={selected.has(m.fixture.id)}
      isFavorite={favoritesSet.has(m.fixture.id)}
      odds={analyzedOdds[m.fixture.id]}
      standings={standings}
      matchData={analyzedData[m.fixture.id]}
      liveStats={liveStats[m.fixture.id]}
      onSelect={toggleSelect}
      onHide={doHide}
      onFavorite={toggleFavorite}
      onView={goToAnalysis}
      userTz={userTz}
    />
  ));

  if (splash) {
    return (
      <div className={`splash ${splashFade ? 'fade-out' : ''}`}>
        <div className="splash-content">
          <div className="splash-logo-wrap">
            <BrandLogoMedia
              className="splash-logo splash-logo-video"
            />
          </div>
          <p className="splash-almost">Ya casi estamos…</p>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="app app-fade-in">
      <div className="container">
        {/* WELCOME tras checkout exitoso — reutiliza el banner verde .batch-banner */}
        {welcome && (
          <div className="batch-banner fade-in" role="status" style={{ justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span aria-hidden="true" style={{ fontSize: '1rem', color: 'var(--green)' }}>&#10003;</span>
              <span>¡Pago confirmado! Bienvenido a CF Análisis.</span>
            </span>
            <button
              aria-label="Cerrar"
              onClick={() => setWelcome(false)}
              style={{ background: 'none', border: 'none', color: 'var(--t2)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: 4 }}
            >&#10005;</button>
          </div>
        )}

        {pushSupported && pushError && (
          <div className="warn fade-in" role="alert">{pushError}</div>
        )}

        {/* CONTROLS: compact date rail + league filter */}
        <div className="controls-row">
          <DashboardDateStrip today={today(userTz)} value={date} onChange={selectDate} />
          <div className="filters-row">
            <LeaguePicker
              leagues={Object.values(leagues).sort((a, b) => a.name.localeCompare(b.name))}
              value={leagueFilter}
              onChange={updateLeagueFilter}
              multiple
              allLeagueIds={allLeagueIds}
              disabled={!leagueFilterReady}
              saving={leagueFilterSaving}
            />
          </div>
        </div>

        {/* APUESTA DEL DIA */}
        {apuestaDelDia && statusFilter !== 'favoritos' && (
          <ApuestaSelectionRail
            selections={apuestaDelDia.selections}
            averageProbability={apuestaDelDia.combinedProbability}
          />
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

        {!loading && statusFilter === 'favoritos' && (
          <FootballCombinationPanel
            customCombinada={customCombinada}
            totalSelections={totalSel}
            onRemove={toggleMarket}
            onClear={() => setSelectedMarkets({})}
            onSave={saveCombinada}
            saving={savingComb}
            savedCombinadas={savedCombinadas}
            onDeleteSaved={deleteSavedCombinada}
          />
        )}

        {/* PARTIDOS SEGÚN EL ESTADO DEL DOCK */}
        {!loading && (
          <>
            {sorted.length === 0 && !error && (
              <div className="empty-state fade-in">
                <div className="empty-icon">&#9917;</div>
                <h3>{statusFilter === 'favoritos'
                  ? 'Sin favoritos para esta fecha'
                  : Array.isArray(leagueFilter) && leagueFilter.length === 0
                    ? 'Ninguna liga seleccionada'
                    : 'Sin partidos'}</h3>
                <p>{statusFilter === 'favoritos'
                  ? 'Marca la estrella de un partido para guardarlo aquí junto a tu combinada.'
                  : Array.isArray(leagueFilter) && leagueFilter.length === 0
                  ? 'Abre el filtro de competición y marca las ligas que quieras ver.'
                  : 'No hay partidos que coincidan con los filtros de esta fecha.'}</p>
              </div>
            )}
            {sorted.length > 0 && (isIOS ? (
              // iOS: sin ventana JS. El virtualizador monta y mide cada fila al
              // entrar en rango, y los impulsos largos de Safari saltan filas
              // enteras sin llegar a montarlas; al volver hacia arriba esas
              // filas se miden por primera vez, pasan de los 310px estimados a
              // su alto real y empujan todo lo de abajo. Medido en WebKit: 13
              // de 34 pasos con tirones de hasta 115px subiendo, 0 bajando.
              // Aquí basta `content-visibility: auto` de .mcard/.acc-card, que
              // ya se salta el render fuera de pantalla y recuerda el alto real.
              <div className="match-list">
                {sorted.map(m => (
                  <div key={m.fixture.id} className="virtual-match-row" style={{ paddingBottom: 8 }}>
                    {renderMatchCard(m)}
                  </div>
                ))}
              </div>
            ) : (
              <div
                ref={matchListRef}
                className="match-list match-list-virtual"
                style={{
                  position: 'relative',
                  display: 'block',
                  height: `${matchVirtualizer.getTotalSize()}px`,
                }}
              >
                {matchVirtualizer.getVirtualItems().map(virtualRow => {
                  const m = sorted[virtualRow.index];
                  if (!m) return null;
                  return (
                    <div
                      key={m.fixture.id}
                      ref={matchVirtualizer.measureElement}
                      data-index={virtualRow.index}
                      className="virtual-match-row"
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        paddingBottom: 8,
                        boxSizing: 'border-box',
                        transform: `translateY(${virtualRow.start - matchListOffset}px)`,
                      }}
                    >
                      {renderMatchCard(m)}
                    </div>
                  );
                })}
              </div>
            ))}
          </>
        )}

        {/* FLOATING: Analyze */}
        {selected.size > 0 && (
          <div className="float-bar float-bar-analyze slide-up">
            <button className="btn-analyze" onClick={analyzeSelected} disabled={analyzing}>
              {analyzing ? 'Analizando...' : `Analizar ${selected.size} partido${selected.size > 1 ? 's' : ''}`}
            </button>
          </div>
        )}

        {/* FLOATING: Combinada counter */}
        {totalSel > 0 && statusFilter !== 'favoritos' && (
          <div className="float-bar float-bar-combinada slide-up">
            <button className="btn-comb-float" onClick={() => setStatusFilter('favoritos')}>
              <span className="float-comb-icon"><Layers3 size={19} aria-hidden="true" /></span>
              <span><small>Tu selección</small><strong>Ver combinada · {totalSel}</strong></span>
              {customCombinada && <span className="float-odd">{customCombinada.combinedOdd}x</span>}
              <ArrowRight size={18} aria-hidden="true" />
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

      </div>
    </div>

    <DashboardStatusDock
      value={statusFilter}
      onChange={setStatusFilter}
      counts={{
        all: allVisibleCount,
        live: liveCount,
        upcoming: upcomingCount,
        finished: finishedCount,
        favorites: favoriteCount,
      }}
      isToday={date === today(userTz)}
      onToday={() => selectDate(today(userTz))}
    />

    {/* MODAL: Análisis completo */}
    {analysisModalId && (
      <AnalysisModal id={analysisModalId} onClose={() => setAnalysisModalId(null)} />
    )}
    </>
  );
}

/* ======================== MATCH CARD ======================== */

function ApuestaSelectionRail({ selections, averageProbability }) {
  return (
    <section className="daily-pick-rail" aria-label="Apuesta del día">
      <div className="daily-pick-track">
        <article className="daily-pick-title-card">
          <span><Target size={19} aria-hidden="true" /></span>
          <small>Selección inteligente</small>
          <strong>Apuesta del día</strong>
          <em>{selections.length} opciones · cuotas individuales</em>
          <b>{cap(averageProbability)}% media</b>
        </article>
        {selections.map((sel, index) => {
          const pct = cap(sel.rawProbability ?? sel.probability);
          const probColor = pct >= 85 ? '#4ade80' : pct >= 80 ? '#fbbf24' : '#d97706';
          const suffixes = { 'Goles': 'goles', 'Córners': 'córners', 'Tarjetas': 'tarjetas' };
          const suffix = suffixes[sel.cat];
          const marketName = suffix && sel.name?.toLowerCase().endsWith(suffix)
            ? `${sel.cat} totales — ${sel.name.slice(0, sel.name.length - suffix.length).trim()}`
            : sel.name;
          const displayMarketName = displayBettingText(marketName);
          return (
            <article
              key={`${sel.fixtureId || 'fixture'}-${sel.id || index}-${index}`}
              className={`daily-pick-card ${sel.priority === 1 ? 'is-live' : ''}`}
            >
              <span className="daily-pick-card-top">
                <i>{sel.priority === 1 ? 'En vivo' : 'Próximo'}</i>
                <b>{String(index + 1).padStart(2, '0')}</b>
              </span>
              <small>{sel.matchName}</small>
              <strong>{displayMarketName}</strong>
              <span className="daily-pick-card-metrics">
                <b style={{ color: probColor }}>{pct}%</b>
                {sel.odd != null && <em>@{Number(sel.odd).toFixed(2)}</em>}
              </span>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function FootballCombinationPanel({
  customCombinada,
  totalSelections,
  onRemove,
  onClear,
  onSave,
  saving,
  savedCombinadas,
  onDeleteSaved,
}) {
  return (
    <section className="favorites-combination-hub fade-in" aria-label="Favoritos y combinada">
      <div className="favorites-combination-heading">
        <span><Layers3 size={19} aria-hidden="true" /></span>
        <span><small>Dentro de Favoritos</small><strong>Tu combinada</strong></span>
        {totalSelections > 0 && <b>{totalSelections}</b>}
      </div>

      {!customCombinada ? (
        <div className="combination-inline-empty">
          <strong>Combinada vacía</strong>
          <span>Expande un partido y selecciona los mercados que quieras combinar.</span>
        </div>
      ) : (
        <div className="comb-builder">
          <div className="comb-hero">
            <span className="comb-hero-icon"><Layers3 size={21} aria-hidden="true" /></span>
            <span><small>Constructor inteligente</small><strong>Tu combinada</strong></span>
            <span className="comb-count">{customCombinada.selections.length} selecciones</span>
          </div>
          <div className="comb-list">
            {customCombinada.selections.map((sel, index) => (
              <article key={`${sel.fixtureId}-${sel.id}`} className="comb-item">
                <span className="comb-item-index">{String(index + 1).padStart(2, '0')}</span>
                <div className="comb-item-content">
                  <div className="comb-item-match">{sel.matchName}</div>
                  <span className="comb-item-name">{displayBettingText(sel.name)}</span>
                </div>
                <div className="comb-item-metrics">
                  <span className={`comb-item-prob ${Number(sel.rawProbability ?? sel.probability) >= 75 ? 'high' : Number(sel.rawProbability ?? sel.probability) >= 50 ? 'mid' : 'low'}`}>
                    <small>Prob.</small>{cap(sel.rawProbability ?? sel.probability)}%
                  </span>
                  <span className="comb-item-odd"><small>Cuota</small>{sel.odd ? Number(sel.odd).toFixed(2) : '—'}</span>
                </div>
                <button className="comb-item-rm" onClick={() => onRemove(sel.fixtureId, sel, sel.matchName)} aria-label={`Quitar ${displayBettingText(sel.name)}`}>
                  <X size={15} aria-hidden="true" />
                </button>
              </article>
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
            {customCombinada.highRisk && <div className="comb-warn">Combinada de alto riesgo (&lt;60%)</div>}
          </div>
          <div className="comb-actions">
            <button className="btn-save-comb" onClick={onSave} disabled={saving}>
              <Save size={16} aria-hidden="true" /> {saving ? 'Guardando...' : 'Guardar combinada'}
            </button>
            <button className="btn-clear" onClick={onClear}><Trash2 size={16} aria-hidden="true" /> Limpiar</button>
          </div>
        </div>
      )}

      {savedCombinadas.length > 0 && (
        <div className="saved-combs">
          <h4 className="saved-combs-title">Combinadas guardadas</h4>
          {savedCombinadas.map((comb) => (
            <div key={comb.id} className="saved-comb">
              <div className="saved-comb-head">
                <span className="saved-comb-name">{comb.name}</span>
                <button className="saved-comb-del" onClick={() => onDeleteSaved(comb.id)} aria-label={`Eliminar ${comb.name}`}>&#10005;</button>
              </div>
              <div className="saved-comb-info">
                <span>{(comb.selections || []).length} sel.</span>
                <span className="saved-comb-odd">{comb.combined_odd ?? comb.combinedOdd}x</span>
                <span className={(comb.combined_probability ?? comb.combinedProbability) >= 60 ? 'safe' : 'danger'}>
                  {cap(comb.combined_probability ?? comb.combinedProbability)}%
                </span>
              </div>
              <div className="saved-comb-sels">
                {(comb.selections || []).map((selection, index) => (
                  <span key={index} className="saved-sel-chip">
                    {displayBettingText(selection.name || selection.market)} {selection.odd ? `(${Number(selection.odd).toFixed(2)})` : ''}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ScoreStatsSummary({ stats }) {
  const cornersCovered = isCoveredCounter(stats?.corners);
  const yellowCovered = isCoveredCounter(stats?.yellowCards);
  const redCovered = isCoveredCounter(stats?.redCards);
  const unavailableTitle = 'Esta competición no entregó este dato';

  return (
    <div className="score-stats-summary" aria-label="Córners y tarjetas del partido">
      <span className={`score-stat-chip${cornersCovered ? '' : ' unavailable'}`} title={cornersCovered ? 'Córners' : unavailableTitle}>
        <span className="score-stat-label"><Flag size={11} aria-hidden="true" /> Córners</span>
        <strong>{cornersCovered ? `${stats.corners.home}-${stats.corners.away}` : '—'}</strong>
      </span>
      <span className={`score-stat-chip cards${yellowCovered || redCovered ? '' : ' unavailable'}`} title={yellowCovered || redCovered ? 'Tarjetas' : unavailableTitle}>
        <span className="score-stat-label"><i className="yellow-card-sm" /> Tarjetas</span>
        <strong>
          <span><i className="yellow-card-sm" /> {yellowCovered ? `${stats.yellowCards.home}-${stats.yellowCards.away}` : '—'}</span>
          <span><i className="red-card-sm" /> {redCovered ? `${stats.redCards.home}-${stats.redCards.away}` : '—'}</span>
        </strong>
      </span>
    </div>
  );
}

const MatchCard = memo(function MatchCard({ match, isAnalyzed, isSelected, isFavorite, odds, standings, matchData, liveStats, onSelect, onHide, onFavorite, onView, userTz }) {
  const live = isLive(match.fixture.status.short);
  const finished = isFinished(match.fixture.status.short);
  const hasScore = live || finished;
  const awaitingOfficialResult = isAwaitingOfficialResult(match);
  const meta = match.leagueMeta || {};
  const flag = FLAGS[meta.country] || '';
  const goalBurst = useGoalBurst((match.goals?.home ?? 0) + (match.goals?.away ?? 0), live);
  const homePos = matchData?.homePosition || standings?.[match.teams.home.id];
  const awayPos = matchData?.awayPosition || standings?.[match.teams.away.id];
  const homeId = match.teams.home.id;
  const tz = userTz || 'UTC';
  const cardDate = new Date(match.fixture.date).toLocaleDateString('es', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' });
  const sLabel = awaitingOfficialResult
    ? 'PENDIENTE DE CONFIRMACIÓN'
    : ({ NS: 'PRÓXIMO', TBD: 'POR CONFIRMAR', '1H': 'EN VIVO — 1T', '2H': 'EN VIVO — 2T', HT: 'ENTRETIEMPO', FT: 'FINALIZADO', ET: 'EN VIVO — Extra', P: 'EN VIVO — Penales', AET: 'FINALIZADO', PEN: 'FINALIZADO', SUSP: 'SUSPENDIDO', PST: 'POSPUESTO', CANC: 'CANCELADO' }[match.fixture.status.short] || match.fixture.status.short);

  return (
    <div
      className={`mcard ${live ? 'live' : ''} ${finished ? 'fin' : ''} ${isSelected ? 'sel' : ''} ${isAnalyzed ? 'done' : ''} mcard-in`}
      onClick={isAnalyzed ? () => onView(match.fixture.id, match) : () => onSelect(match.fixture.id)}
    >
      {/* Convertido de motion.div → div: el prop `layout` de framer-motion
          animaba el reflow 130px→320px al expandir el acordeón, recalculando
          posiciones en cada frame (lentísimo con la lista virtualizada).
          Sin layout, expandir es instantáneo. La entrada (fade-in) y el hover
          ahora son CSS (.mcard-in / :hover) — corren en el compositor, no en
          el main thread JS, así no compiten con la apertura del acordeón. */}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── Fila 1: Liga + Fecha ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.82rem', fontWeight: 600, color: '#f1f5f9' }}>
            {match.league.logo
              ? <img src={match.league.logo} alt={match.league.name} title={match.league.name} className="league-logo" loading="lazy" decoding="async" />
              : <span>{flag} {match.league.name}</span>}
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
          {odds && (() => {
            const bkName = matchData?.odds?.bookmaker;
            const bkLogo = bkName ? (BOOKMAKER_LOGOS[bkName.toLowerCase()] || Object.entries(BOOKMAKER_LOGOS).find(([k]) => bkName.toLowerCase().includes(k))?.[1]) : null;
            return (
              <div className="card-odds-row">
                {bkName && (
                  <div className="card-bookmaker" title={bkName}>
                    {bkLogo && <img className="card-bookmaker-logo" src={bkLogo} alt={bkName} loading="lazy" decoding="async" />}
                    <span>{bkName}</span>
                  </div>
                )}
                {odds.home != null && <div className="card-odd is-home">{odds.home.toFixed(2)}</div>}
                {odds.draw != null && <div className="card-odd is-draw">X {odds.draw.toFixed(2)}</div>}
                {odds.away != null && <div className="card-odd is-away">{odds.away.toFixed(2)}</div>}
              </div>
            );
          })()}

          {matchData?.referee && (
            <div className="card-referee">
              <Scale size={16} aria-hidden="true" />
              <span><small>Árbitro</small><strong>{matchData.referee}</strong></span>
              {matchData.refereeStats?.avgYellows != null && (
                <i className="is-yellow">{Number(matchData.refereeStats.avgYellows).toFixed(1)}</i>
              )}
              {matchData.refereeStats?.avgReds != null && (
                <i className="is-red">{Number(matchData.refereeStats.avgReds).toFixed(2)}</i>
              )}
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

        {/* ── Score Box ── glow vía CSS (.score-box-glow), no framer-motion.
            Los `animate={{boxShadow:[...]}} repeat:Infinity` corrían en el
            main thread JS por cada card visible a la vez → al expandir el
            acordeón competían por CPU y lo trababan. Movido a @keyframes CSS
            (compositor GPU). backdropFilter:blur removido — era lo más caro de
            repintar y el glow ya da el efecto. */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <div className="score-box-glow" style={{ position: 'relative', width: '100%', borderRadius: 20, background: 'linear-gradient(135deg, rgba(30,135,105,.25), rgba(0,0,9,.4), rgba(30,135,105,.15))', border: '2px solid rgba(30,135,105,.5)', padding: '16px 20px' }}>
            {goalBurst && <GoalBurst />}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>

              {/* Badge de estado */}
              <div>
                {live ? (
                  <div className="ap2-live-badge live-badge-glow">
                    <span className="ap2-live-dot live-dot-pulse" />
                    {(match.fixture.status.short === 'HT' || match.fixture.status.short === 'BT') ? '' : 'EN VIVO'}
                    {match.fixture.status.elapsed > 0 && (
                      <span style={{ marginLeft: 4 }}>
                        <MatchTimer elapsed={match.fixture.status.elapsed} extra={match.fixture.status.extra} status={match.fixture.status.short} />
                      </span>
                    )}
                  </div>
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
                    <SlotScore value={match.goals.home} className="score-num-glow" style={{ fontSize: 'clamp(2.5rem, 8vw, 3.5rem)', fontWeight: 700, lineHeight: 1, color: '#f1f5f9' }} />

                    <ScoreStatsSummary stats={liveStats} />

                    <SlotScore value={match.goals.away} className="score-num-glow" style={{ fontSize: 'clamp(2.5rem, 8vw, 3.5rem)', fontWeight: 700, lineHeight: 1, color: '#f1f5f9' }} />
                  </>
                ) : awaitingOfficialResult ? (
                  <div className="score-awaiting-result">Esperando marcador oficial</div>
                ) : (
                  <div style={{ fontSize: 'clamp(1.5rem, 5vw, 2rem)', fontWeight: 700, color: '#f1f5f9' }}>
                    {fmtTime(match.fixture.date, userTz)}
                  </div>
                )}
              </div>

              {/* Goleadores — 2 columnas igual al analisis */}
              {liveStats && (liveStats.goalScorers?.length > 0 || liveStats.missedPenalties?.length > 0) && (
                <GoalScorersGrid liveStats={liveStats} homeId={homeId} />
              )}

            </div>
          </div>
        </div>

        {/* ── Footer: selección / favorito / ocultar ── */}
        <div className="mcard-foot">
          {isAnalyzed ? (
            <span className="tag-done">&#10003; ANALIZADO</span>
          ) : (
            <label className="mcard-cb" onClick={e => e.stopPropagation()}>
              <input type="checkbox" checked={isSelected} onChange={() => onSelect(match.fixture.id)} />
              <span className="cb-mark" />
            </label>
          )}
          {onFavorite && (
            <button
              className={`btn-fav${isFavorite ? ' active' : ''}`}
              onClick={(e) => onFavorite(e, match.fixture.id)}
              title={isFavorite ? 'Quitar de favoritos' : 'Agregar a favoritos'}
            >&#9733;</button>
          )}
          <button className="btn-x" onClick={(e) => { e.stopPropagation(); onHide(e, match.fixture.id); }}>&#10005;</button>
        </div>

      </div>
    </div>
  );
});

/* ======================== ANALYSIS MODAL ======================== */

function AnalysisModal({ id, onClose }) {
  return (
    <AnalysisFullModal
      onClose={onClose}
      ariaLabel="Análisis completo"
    >
      <AnalysisExperience fixtureId={id} embedded onClose={onClose} />
    </AnalysisFullModal>
  );
}

/* ======================== ACCORDION CARD ======================== */

// Toggle de sub-acordeón + revelado del header.
//
// POR QUÉ el scrollIntoView: al abrir un sub-acordeón el contenido crece hacia
// abajo y el header recién pulsado puede quedar fuera del viewport. Tras abrir
// (doble rAF = esperar a que el layout se asiente) lo traemos de vuelta con
// block:'nearest', que NO mueve la vista si ya está visible; solo lo reencuadra
// si quedó fuera. Mismo helper que el dashboard de baseball.
function toggleSubAndReveal(e, open, id, setOpenSub) {
  e.stopPropagation();
  const header = e.currentTarget; // capturar antes del async (luego puede ser null)
  setOpenSub(open ? null : id);
  if (!open && header) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try { header.scrollIntoView({ block: 'nearest' }); } catch {}
    }));
  }
}

// SubAccordion CONTROLADO + exclusivo. El estado de "cuál está abierto" vive
// en el AccordionCard padre (openSub/setOpenSub), así solo uno está abierto a
// la vez. children SIEMPRE montados (grid 0fr→1fr), el toggle solo cambia CSS
// → apertura instantánea garantizada incluso la 1ª vez. Transición 150ms.
function SubAccordion({ id, title, color, icon: Icon = BarChart3, openSub, setOpenSub, children }) {
  const open = openSub === id;
  return (
    <section className="subacc-section" style={{ '--subacc-accent': color || 'var(--dash-green)' }}>
      <button
        type="button"
        className="subacc-trigger"
        onClick={(e) => toggleSubAndReveal(e, open, id, setOpenSub)}
        aria-expanded={open}
      >
        <span><i><Icon size={17} aria-hidden="true" /></i><strong>{title}</strong></span>
        <ChevronDown className={open ? 'is-open' : ''} size={17} aria-hidden="true" />
      </button>
      <div className="subacc-grid" data-open={open ? '1' : '0'}>
        <div className="subacc-overflow">
          <div className="subacc-body">{children}</div>
        </div>
      </div>
    </section>
  );
}

const AccordionCard = memo(function AccordionCard({ match, data, odds, standings, liveStats, isExpanded, onToggle, selMarkets, onToggleMarket, onViewFull, onRemove, isFavorite, onFavorite, userTz }) {
  // Estado de sub-acordeón EXCLUSIVO (solo uno abierto a la vez). Los 3 bloques
  // (Estadísticas / Probabilidades / Jugadores) leen openSub y lo togglean.
  const [openSub, setOpenSub] = useState('markets');
  const live = isLive(match.fixture.status.short);
  const finished = isFinished(match.fixture.status.short);
  const hasScore = live || finished;
  const awaitingOfficialResult = isAwaitingOfficialResult(match);
  const meta = match.leagueMeta || {};
  const flag = FLAGS[meta.country] || '';
  const selCount = Object.keys(selMarkets).length;
  const goalBurst = useGoalBurst((match.goals?.home ?? 0) + (match.goals?.away ?? 0), live);
  const homePos = data?.homePosition || standings?.[match.teams.home.id];
  const awayPos = data?.awayPosition || standings?.[match.teams.away.id];
  const homeId = match.teams.home.id;
  const fixtureId = match.fixture.id;
  const matchName = `${match.teams.home.name} vs ${match.teams.away.name}`;
  const tz = userTz || 'UTC';
  const cardDate = new Date(match.fixture.date).toLocaleDateString('es', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' });
  const sLabel = awaitingOfficialResult
    ? 'PENDIENTE DE CONFIRMACIÓN'
    : ({ NS: 'PRÓXIMO', TBD: 'POR CONFIRMAR', '1H': 'EN VIVO — 1T', '2H': 'EN VIVO — 2T', HT: 'ENTRETIEMPO', FT: 'FINALIZADO', ET: 'EN VIVO — Extra', P: 'EN VIVO — Penales', AET: 'FINALIZADO', PEN: 'FINALIZADO', SUSP: 'SUSPENDIDO', PST: 'POSPUESTO', CANC: 'CANCELADO' }[match.fixture.status.short] || match.fixture.status.short);

  // "Selecciona para tu combinada" → fuente única: el catálogo canónico
  // creado por el motor. No se reconstruyen opciones desde porcentajes porque
  // esa ruta perdería el dato de fiabilidad exigido por la política pública.
  const markets = useMemo(() => {
    if (!isExpanded) return [];
    // "Selecciona para tu combinada": usa data.combinada.SELECTABLE — TODA línea con
    // prob≥70% y cuota real ≥1.20 (bet365/bwin, con equivalencia de línea entera). NO
    // el gate ≥80% de recomendaciones generales (eso es `selections`).
    const isEngine = data?.combinada?.source === 'context-engine';
    const sels = isEngine
      ? (data.combinada.selectable || data.combinada.selections || [])
      : [];
    return sels
      // P6: filtro 1.20 mínimo (alineado con MIN_DISPLAY_ODDS en lib/constants.js)
      .filter(s => meetsFootballReliability(s.confidence)
        && s.odd && s.odd >= 1.20
        && Number(s.rawProbability ?? s.probability) >= 70)
      .map((s, i) => ({
        id: s.id || `mkt-${i}`,
        // Re-traduce la clave con lib/market-labels.js (misma fuente que el servidor y que la
        // "Apuesta del Día", línea ~1074) en vez de usar s.name CACHEADO: así las etiquetas
        // nuevas (hándicap ah_/eh_, marcador exacto cs_) salen legibles incluso en análisis
        // cacheados ANTES del fix de etiquetas. scope 'player' conserva su name (id no es clave).
        name: s.scope === 'context' ? marketLabel(s.id, { home: match.teams.home.name, away: match.teams.away.name }) : s.name,
        probability: s.probability,
        rawProbability: s.rawProbability,
        odd: s.odd,
        bookmaker: s.bookmaker || null,   // bookmaker real atribuido por el motor
        recommended: s.recommended === true,
        // cat se mantiene para los logos del bookmaker (catMap mas abajo)
        cat: s.scope === 'player' ? 'Player'
           : s.category?.includes('corners') ? 'Corners'
           : s.category?.includes('cards')   ? 'Tarjetas'
           : s.category?.includes('goals') || s.category === 'winner' || s.category === 'btts' ? 'Goles'
           : s.category || 'Otros',
      }))
      .sort((a, b) => Number(b.rawProbability ?? b.probability) - Number(a.rawProbability ?? a.probability));
  }, [isExpanded, data, match]);

  return (
    <div className={`acc-card ${isExpanded ? 'open' : ''}`}>
      {/* Header */}
      <div className="acc-head" onClick={() => onToggle(fixtureId)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* ── Fila 1: Liga + Fecha ── */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.82rem', fontWeight: 600, color: '#f1f5f9' }}>
              {match.league.logo && <img src={match.league.logo} alt="" className="league-logo" loading="lazy" decoding="async" />}
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
            {odds && (() => {
              const bkName = data?.odds?.bookmaker;
              const bkLogo = bkName ? (BOOKMAKER_LOGOS[bkName.toLowerCase()] || Object.entries(BOOKMAKER_LOGOS).find(([k]) => bkName.toLowerCase().includes(k))?.[1]) : null;
              return (
              <div className="card-odds-row">
                {bkName && (
                    <div className="card-bookmaker" title={bkName}>
                      {bkLogo && <img className="card-bookmaker-logo" src={bkLogo} alt={bkName} loading="lazy" decoding="async" />}
                      <span>{bkName}</span>
                    </div>
                  )}
                  {odds.home != null && <div className="card-odd is-home">{odds.home.toFixed(2)}</div>}
                  {odds.draw != null && <div className="card-odd is-draw">X {odds.draw.toFixed(2)}</div>}
                  {odds.away != null && <div className="card-odd is-away">{odds.away.toFixed(2)}</div>}
                </div>
              );
            })()}

            {/* Árbitro */}
            {data?.referee && (
              <div className="card-referee">
                <Scale size={16} aria-hidden="true" />
                <span><small>Árbitro</small><strong>{data.referee}</strong></span>
                {data.refereeStats?.avgYellows != null && (
                  <i className="is-yellow">{Number(data.refereeStats.avgYellows).toFixed(1)}</i>
                )}
                {data.refereeStats?.avgReds != null && (
                  <i className="is-red">{Number(data.refereeStats.avgReds).toFixed(2)}</i>
                )}
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

          {/* ── Score Box ── glow vía CSS (igual que MatchCard). Antes tenía
              4 loops motion repeat:Infinity + backdropFilter:blur que corrían
              en el main thread por cada card analizado visible → competían con
              la apertura de los sub-acordeones. Movido a @keyframes CSS (GPU). */}
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <div className="score-box-glow" style={{ position: 'relative', width: '100%', borderRadius: 20, background: 'linear-gradient(135deg, rgba(30,135,105,.25), rgba(0,0,9,.4), rgba(30,135,105,.15))', border: '2px solid rgba(30,135,105,.5)', padding: '16px 20px' }}>
              {goalBurst && <GoalBurst />}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>

                {/* Badge de estado */}
                <div>
                  {live ? (
                    <div className="ap2-live-badge live-badge-glow">
                      <span className="ap2-live-dot live-dot-pulse" />
                      {(match.fixture.status.short === 'HT' || match.fixture.status.short === 'BT') ? '' : 'EN VIVO'}
                      {match.fixture.status.elapsed > 0 && (
                        <span style={{ marginLeft: 4 }}>
                          <MatchTimer elapsed={match.fixture.status.elapsed} extra={match.fixture.status.extra} status={match.fixture.status.short} />
                        </span>
                      )}
                    </div>
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
                      <SlotScore value={match.goals.home} className="score-num-glow" style={{ fontSize: 'clamp(2.5rem, 8vw, 3.5rem)', fontWeight: 700, lineHeight: 1, color: '#f1f5f9' }} />

                      <ScoreStatsSummary stats={liveStats} />

                      <SlotScore value={match.goals.away} className="score-num-glow" style={{ fontSize: 'clamp(2.5rem, 8vw, 3.5rem)', fontWeight: 700, lineHeight: 1, color: '#f1f5f9' }} />
                    </>
                  ) : awaitingOfficialResult ? (
                    <div className="score-awaiting-result">Esperando marcador oficial</div>
                  ) : (
                    <div style={{ fontSize: 'clamp(1.5rem, 5vw, 2rem)', fontWeight: 700, color: '#f1f5f9' }}>
                      {fmtTime(match.fixture.date, userTz)}
                    </div>
                  )}
                </div>

                {/* Goleadores — 2 columnas con foto (componente compartido) */}
                <GoalScorersGrid liveStats={liveStats} homeId={homeId} />

              </div>
            </div>
          </div>

          {/* ── Indicador: remove / fav / selCount / prob / chevron ── */}
          <div className="acc-indicator">
            {onRemove && (
              <button className="btn-x acc-rm" onClick={e => onRemove(e, fixtureId)} title="Eliminar de analizados">&#10005;</button>
            )}
            {onFavorite && (
              <button
                className={`btn-fav${isFavorite ? ' active' : ''}`}
                onClick={e => onFavorite(e, fixtureId)}
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
      {isExpanded && <div className="acc-content open">
        <div className="acc-inner">
          {data ? (
            <>
              {/* LiveMatchDetails ELIMINADO entero: goleadores+minutos+marcador
                  ya los muestra el score box de la tarjeta. Era 100% redundante. */}

              {/* Selectable markets — BEFORE auto combinada */}
              {markets.length > 0 && (
                <SubAccordion
                  id="markets"
                  openSub={openSub}
                  setOpenSub={setOpenSub}
                  title={`Mercados para tu combinada · ${markets.length}`}
                  icon={Layers3}
                  color="#5ee6b1"
                >
                  <div className="markets">
                    <div className="markets-grid">
                  {markets.map(mkt => {
                    const checked = !!selMarkets[mkt.id];
                    // Logo del bookmaker REAL atribuido por el motor (allBookmakerOdds).
                    // Si no hay bookmaker → sin logo (cuota fantasma no debería llegar aquí).
                    const bkLogo = mkt.bookmaker
                      ? (BOOKMAKER_LOGOS[mkt.bookmaker.toLowerCase()] || Object.entries(BOOKMAKER_LOGOS).find(([k]) => mkt.bookmaker.toLowerCase().includes(k))?.[1])
                      : null;
                    return (
                      <button
                        key={mkt.id}
                        className={`mkt ${checked ? 'on' : ''} ${mkt.probability >= 75 ? 'hi' : mkt.probability >= 50 ? 'md' : 'lo'}`}
                        onClick={(e) => { e.stopPropagation(); onToggleMarket(fixtureId, mkt, matchName); }}
                      >
                        <span className="mkt-name">{displayBettingText(mkt.name)}</span>
                        <span className={`mkt-validation ${mkt.recommended ? 'is-validated' : 'is-reference'}`}>
                          {mkt.recommended ? 'Recomendación estadística' : 'Dato estadístico'}
                        </span>
                        <div className="mkt-bar"><div className="mkt-fill" style={{ width: `${cap(mkt.rawProbability ?? mkt.probability)}%` }} /></div>
                        <div className="mkt-nums">
                          <span className="mkt-pct">{cap(mkt.rawProbability ?? mkt.probability)}%</span>
                          {mkt.odd && <span className="mkt-odd">{mkt.odd.toFixed(2)}</span>}
                          {bkLogo && <span className="mkt-bk" title={mkt.bookmaker}><img src={bkLogo} alt={mkt.bookmaker} className="bk-logo-lg" loading="lazy" decoding="async" onError={(e) => { e.target.style.display = 'none'; }} /></span>}
                          {checked && <span className="mkt-chk">&#10003;</span>}
                        </div>
                      </button>
                    );
                  })}
                    </div>
                  </div>
                </SubAccordion>
              )}

              {/* ── Estadísticas calculadas (extraído del análisis completo) ── */}
              {data.calculatedProbabilities && (() => {
                const p = data.calculatedProbabilities;
                const ccd = p.cornerCardData || {};
                const hn = match.teams.home.name;
                const an = match.teams.away.name;
                const fmt = (v) => (v == null || Number.isNaN(v) ? '—' : (typeof v === 'number' ? v.toFixed(2) : v));
                const Cell = ({ label, value, color }) => (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <span style={{ fontSize: '.72rem', color: 'var(--t3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 8 }}>{label}</span>
                    <span style={{ fontSize: '.85rem', fontWeight: 700, color: color || 'var(--t1)', fontFamily: 'JetBrains Mono, monospace', fontVariantNumeric: 'tabular-nums' }}>{fmt(value)}</span>
                  </div>
                );
                const StatCard = ({ title, accent, children }) => (
                  <div style={{ background: 'var(--bg-2)', border: `1px solid ${accent || 'var(--brd)'}`, borderRadius: 10, padding: '10px 12px', flex: '1 1 220px', minWidth: 0 }}>
                    <div style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--t2)', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
                    {children}
                  </div>
                );
                return (
                  <SubAccordion id="stats" openSub={openSub} setOpenSub={setOpenSub} title="Estadísticas calculadas" color="#f97316">
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                      <StatCard title={`Goles — ${hn}`} accent="rgba(0,212,255,.25)">
                        <Cell label="Prom. anotados"      value={p.homeGoals?.avgScored}   color="#4ade80" />
                        <Cell label="Prom. recibidos"     value={p.homeGoals?.avgConceded} color="#f87171" />
                        <Cell label="Prom. vs rival H2H"  value={p.h2hGoals?.homeAvg}      color="#67e8f9" />
                      </StatCard>
                      <StatCard title={`Goles — ${an}`} accent="rgba(236,72,153,.25)">
                        <Cell label="Prom. anotados"      value={p.awayGoals?.avgScored}   color="#4ade80" />
                        <Cell label="Prom. recibidos"     value={p.awayGoals?.avgConceded} color="#f87171" />
                        <Cell label="Prom. vs rival H2H"  value={p.h2hGoals?.awayAvg}      color="#f472b6" />
                      </StatCard>
                      <StatCard title="Córners (últimos 5)" accent="rgba(34,197,94,.25)">
                        <Cell label={`${hn} a favor`}    value={ccd.homeCornersAvg} />
                        <Cell label={`${hn} en contra`}  value={ccd.homeCornersAgainstAvg} />
                        <Cell label={`${an} a favor`}    value={ccd.awayCornersAvg} />
                        <Cell label={`${an} en contra`}  value={ccd.awayCornersAgainstAvg} />
                        <Cell label="Total combinado"    value={p.cornerAvg} color="#4ade80" />
                      </StatCard>
                      <StatCard title="Tarjetas (últimos 5)" accent="rgba(245,158,11,.25)">
                        <Cell label={`${hn} amarillas`} value={ccd.homeYellowsAvg} />
                        <Cell label={`${hn} rojas`}     value={ccd.homeRedsAvg} />
                        <Cell label={`${an} amarillas`} value={ccd.awayYellowsAvg} />
                        <Cell label={`${an} rojas`}     value={ccd.awayRedsAvg} />
                        <Cell label="Total amarillas prom." value={p.cardAvg} color="#fbbf24" />
                      </StatCard>
                    </div>
                  </SubAccordion>
                );
              })()}

              {/* ── % Frecuencias calculadas (independientes de la publicación de cuota) ── */}
              <AccordionProbBlock
                id="probs" openSub={openSub} setOpenSub={setOpenSub}
                probabilities={data.calculatedProbabilities}
                odds={data.odds}
                homeTeam={match.teams.home.name}
                awayTeam={match.teams.away.name}
              />

              <FinalVerdictPanel
                verdict={data.finalVerdict}
                homeName={match.teams.home.name}
                awayName={match.teams.away.name}
                compact
              />

              {/* ── Jugadores destacados ── */}
              <AccordionPlayersBlock id="players" openSub={openSub} setOpenSub={setOpenSub} highlights={data.playerHighlights} />

              {/* Last5Block y StatsBlock se quitaron del acordeon: son datos
                  base de input al modelo, no recomendaciones accionables. El
                  detalle completo (last5 partidos, goal-timing, etc.) sigue
                  disponible en "Ver analisis completo". */}

              <button className="btn-full" onClick={(e) => { e.stopPropagation(); onViewFull(fixtureId, match); }}>
                <span><small>Explora cada indicador</small><strong>Ver análisis completo</strong></span>
                <ArrowRight size={18} aria-hidden="true" />
              </button>
            </>
          ) : (
            <div className="no-data-inline">Sin datos de analisis</div>
          )}
        </div>
      </div>}
    </div>
  );
});

/* ======================== LIVE STATS COMPONENTS ======================== */

// Marcador estilo tragaperras: cuando el número CAMBIA, el nuevo "baja" desde
// arriba con un rebote (keyframe score-roll). Re-monta el span interior vía
// `animKey` para reproducir la animación; en el primer render NO anima (así no
// rueda todo al cargar la página, solo cuando llega un gol de verdad).
function SlotScore({ value, className = '', style }) {
  const [animKey, setAnimKey] = useState(0);
  const prev = useRef(value);
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current && value !== prev.current) setAnimKey(k => k + 1);
    prev.current = value;
    mounted.current = true;
  }, [value]);
  return (
    <span className={className} style={{ ...style, display: 'inline-block', overflow: 'visible' }}>
      <span key={animKey} className={animKey ? 'score-roll' : ''} style={{ display: 'inline-block' }}>
        {value}
      </span>
    </span>
  );
}

// Detecta gol: el total de goles SUBE estando en vivo → true por 2.6s. En el
// primer render no dispara (guarda `mounted`), así no salta al cargar partidos
// que ya tenían marcador. Compartido por MatchCard y AccordionCard.
function useGoalBurst(total, live) {
  const [burst, setBurst] = useState(false);
  const prev = useRef(total);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; prev.current = total; return; }
    if (live && total > prev.current) {
      setBurst(true);
      prev.current = total;
      const t = setTimeout(() => setBurst(false), 2600);
      return () => clearTimeout(t);
    }
    prev.current = total;
  }, [total, live]);
  return burst;
}

// Overlay "GOL" — push elegante sobre el score box (scale+fade, flash verde).
// pointer-events:none para no bloquear el click de la tarjeta.
function GoalBurst() {
  return (
    <div className="goal-burst" aria-hidden="true">
      <span className="goal-burst-txt">⚽ GOL</span>
    </div>
  );
}

// Foto oficial del jugador (API-Football). Fallback a placeholder si no hay id
// o la imagen 404ea. loading=lazy para no bloquear el scroll.
const playerFace = (id) => id ? `/api/player-photo/${id}` : null;
const eventPersonName = (value) => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value.name === 'string' && value.name.trim()) return value.name.trim();
  return 'Autor no informado';
};
function PlayerFace({ id, size = 18 }) {
  const [err, setErr] = useState(false);
  const src = playerFace(id);
  if (!src || err) return <span className="scorer-face scorer-face-ph" style={{ width: size, height: size }} aria-hidden="true" />;
  return <img src={src} alt="" width={size} height={size} className="scorer-face" loading="lazy" decoding="async" onError={() => setErr(true)} />;
}

// Línea de goleador con foto + minuto + nombre. side='home' (izq, verde) /
// 'away' (der, blanco; row-reverse → foto al borde exterior).
function ScorerLine({ g, side }) {
  const sfx = g.type === 'Penalty' ? ' (P)' : g.type === 'Own Goal' ? ' (AG)' : '';
  const min = `${g.minute}${g.extra ? `+${g.extra}` : ''}'`;
  return (
    <div className={`scorer-line${side === 'away' ? ' right' : ''}`}>
      <PlayerFace id={g.playerId} />
      <span className="scorer-txt" style={{ color: side === 'home' ? '#6ee7b7' : '#f1f5f9' }}>
        <span className="scorer-min">{min}</span> {eventPersonName(g.player)}{sfx}
      </span>
    </div>
  );
}

// Penalti fallado (✗ naranja).
function MissedLine({ p, side }) {
  return (
    <div className={`scorer-line${side === 'away' ? ' right' : ''}`}>
      <PlayerFace id={p.playerId} />
      <span className="scorer-txt" style={{ color: '#fb923c' }}>
        <span className="scorer-min">✗ {p.minute}&#39;</span> {eventPersonName(p.player)}
      </span>
    </div>
  );
}

// Rejilla de goleadores (local izq / visitante der) con fotos. Devuelve null si
// no hay nada. Compartida por MatchCard y AccordionCard.
function GoalScorersGrid({ liveStats, homeId }) {
  if (!liveStats || (!(liveStats.goalScorers?.length) && !(liveStats.missedPenalties?.length))) return null;
  const goals = liveStats.goalScorers || [];
  const missed = liveStats.missedPenalties || [];
  const homeGoals = goals.filter(g => g.teamId === homeId);
  const awayGoals = goals.filter(g => g.teamId !== homeId);
  const homeMissed = missed.filter(p => p.teamId === homeId);
  const awayMissed = missed.filter(p => p.teamId !== homeId);
  return (
    <div style={{ width: '100%', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        {homeGoals.map((g, i) => <ScorerLine key={`g${i}`} g={g} side="home" />)}
        {homeMissed.map((p, i) => <MissedLine key={`m${i}`} p={p} side="home" />)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        {awayGoals.map((g, i) => <ScorerLine key={`g${i}`} g={g} side="away" />)}
        {awayMissed.map((p, i) => <MissedLine key={`m${i}`} p={p} side="away" />)}
      </div>
    </div>
  );
}

function MatchTimer({ elapsed, extra, status }) {
  // Minuto EXACTO de API-Football, sin interpolación ni offset local.
  //   - fixture.status.elapsed = minuto base (45/90/120).
  //   - fixture.status.extra   = minutos de adición TRANSCURRIDOS (va 1,2,3...),
  //     NO el total decretado por el árbitro. API-Football no expone el total
  //     decretado en ningún campo, así que no se puede mostrar "(+5)" sin
  //     inventarlo.
  //
  // Minuto real en curso = elapsed + extra (ej. 90 + 1 = 91'). Cuando no hay
  // adición, solo el minuto base (67').
  if (status === 'HT') return <span>DESCANSO</span>;
  if (status === 'BT') return <span>DESCANSO ET</span>;
  if (status === 'P')  return <span>PENALES</span>;

  const base = Number(elapsed) || 0;
  const add  = Number(extra)   || 0;
  // Indicador de tiempo (1T/2T/TE) junto al minuto, como bet365/sofascore.
  const half = status === '1H' ? '1T' : status === '2H' ? '2T' : status === 'ET' ? 'TE' : null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      {half && <span className="half-tag">{half}</span>}
      <span>{base + add}&apos;</span>
    </span>
  );   // "2T 67'" en 2H 67, "1T 47'" en 45+2
}

function LiveStatsBar({ stats }) {
  if (!stats) return null;
  const { corners, yellowCards, redCards } = stats;
  // Always render if at least one stat object is present (even 0-0 shows the icon)
  if (!isCoveredCounter(corners) && !isCoveredCounter(yellowCards) && !isCoveredCounter(redCards)) return null;

  return (
    <div className="live-stats-bar">
      {isCoveredCounter(corners) && (
        <span className="ls-item" title="Corners">
          <span className="ls-icon corner-icon">&#9873;</span>
          {corners.home}-{corners.away}
          <span className="ls-total">({corners.total})</span>
        </span>
      )}
      {isCoveredCounter(yellowCards) && (
        <span className="ls-item" title="Tarjetas amarillas">
          <span className="ls-icon yellow-card" />
          {yellowCards.home}-{yellowCards.away}
        </span>
      )}
      {isCoveredCounter(redCards) && (redCards.home > 0 || redCards.away > 0) && (
        <span className="ls-item" title="Tarjetas rojas">
          <span className="ls-icon red-card" />
          {redCards.home}-{redCards.away}
        </span>
      )}
    </div>
  );
}

// ===================== ACCORDION PROBABILITIES BLOCK =====================
// Replica el bloque "% Probabilidades calculadas" del analisis completo
// (app/dashboard/analisis/[id]/page.js → SECCION 8). Misma data, render
// compacto sin animaciones pesadas — el acordeon es vista resumida.

function AccordionProbBlock({ probabilities: p, odds, homeTeam, awayTeam, id, openSub, setOpenSub }) {
  // catOpen exclusivo (key de categoría abierta o null) — una categoría a la vez.
  const [catOpen, setCatOpen] = useState(null);

  // TODO el cálculo de categorías se memoiza:
  // antes corría en CADA toggle (setState re-renderiza) → era lo que trababa
  // la apertura. Con useMemo solo recalcula si cambian las props reales.
  const groupDefs = useMemo(() => {
  if (!p) return [];
  const allCats = buildFootballProbabilityGroups(p, odds, homeTeam, awayTeam);

  return [
    { key: 'goles',    label: 'Goles',     color: '#4ade80' },
    { key: 'corners',  label: 'Córners',   color: '#fbbf24' },
    { key: 'tarjetas', label: 'Tarjetas',  color: '#f59e0b' },
    { key: 'tiros',    label: 'Tiros',     color: '#3b82f6' },
    { key: 'faltas',   label: 'Faltas',    color: '#fb923c' },
    { key: 'offsides', label: 'Fueras de juego', color: '#a78bfa' },
  ].map(g => ({ ...g, cats: allCats.filter(c => c.group === g.key) }))
   .filter(g => g.cats.length > 0);
  }, [p, odds, homeTeam, awayTeam]);

  if (!p || groupDefs.length === 0) return null;
  const open = openSub === id;

  const ProbItem = ({ it }) => {
    const v = cap(it.value);
    const color = v >= 80 ? '#4ade80' : v >= 65 ? '#fbbf24' : v >= 50 ? '#f97316' : '#94a3b8';
    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', gap: 8 }}>
        <span style={{ fontSize: '.72rem', color: 'var(--t3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
        <span style={{ fontSize: '.62rem', color: it.odd ? '#67e8f9' : 'var(--t3)', whiteSpace: 'nowrap' }}>{it.odd ? `Cuota ${it.odd.toFixed(2)}` : 'Cuota pendiente'}</span>
        <span style={{ fontSize: '.85rem', fontWeight: 700, color, fontFamily: 'JetBrains Mono, monospace', fontVariantNumeric: 'tabular-nums' }}>{v}%</span>
      </div>
    );
  };

  return (
    <section className="subacc-section" style={{ '--subacc-accent': '#2dd4bf' }}>
      <button
        type="button"
        className="subacc-trigger"
        onClick={(e) => toggleSubAndReveal(e, open, id, setOpenSub)}
        aria-expanded={open}
      >
        <span><i><BarChart3 size={17} aria-hidden="true" /></i><strong>Frecuencias calculadas</strong></span>
        <ChevronDown className={open ? 'is-open' : ''} size={17} aria-hidden="true" />
      </button>
      <div className="subacc-grid" data-open={open ? '1' : '0'}>
        <div className="subacc-overflow">
          <div className="subacc-body">
            <p className="probability-explainer">La media resume cuántos eventos hubo por partido; cada porcentaje cuenta en cuántos antecedentes se superó esa línea. Son medidas distintas.</p>
            {groupDefs.map(g => (
              <section key={g.key} className="subacc-group" style={{ '--subacc-group-accent': g.color }}>
                <button
                  type="button"
                  className="subacc-group-trigger"
                  onClick={(e) => { e.stopPropagation(); setCatOpen(prev => (prev === g.key ? null : g.key)); }}
                  aria-expanded={catOpen === g.key}
                >
                  <span>{g.label}<small>{g.cats.length} bloques</small></span>
                  <ChevronDown className={catOpen === g.key ? 'is-open' : ''} size={16} aria-hidden="true" />
                </button>
                <div className="subacc-grid" data-open={catOpen === g.key ? '1' : '0'}>
                  <div className="subacc-overflow">
                    <div className="subacc-data-grid">
                      {g.cats.map((cat, ci) => (
                        <div key={ci} className="subacc-data-card">
                          <div style={{ fontSize: '.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--t2)', marginBottom: cat.subtitle ? 2 : 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cat.title}</div>
                          {cat.subtitle && <div style={{ fontSize: '.65rem', color: 'var(--t3)', marginBottom: 6 }}>{cat.subtitle}</div>}
                          {cat.items.map((it, i) => <ProbItem key={i} it={it} />)}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ===================== ACCORDION PLAYERS BLOCK =====================
// Version compacta de PlayerHighlights del analisis completo. Muestra
// scorers/shooters/assisters/foulers/bookers con su histograma (10 dots,
// uno por partido). Sin las animaciones motion del analisis — el acordeon
// se abre/cierra muchas veces durante la sesion, animar todo seria pesado.

function AccordionPlayersBlock({ highlights, id, openSub, setOpenSub }) {
  const [grpOpen, setGrpOpen] = useState(null); // grupo exclusivo o null

  const groups = useMemo(() => {
    if (!highlights) return [];
    const { scorers, shooters, shotsTotalists, assisters, foulers, bookers } = highlights;
    return [
      { key: 'scorers',        data: scorers,        label: 'Goleadores en racha',  hint: '(gol en 5+ de últimos 10)',                               emoji: '⚽',  dotColor: '#22c55e', metric: 'goals',       unit: 'goles' },
      { key: 'shooters',       data: shooters,       label: 'Tiros a puerta',        hint: '(remate al arco — 5+ de últimos 10)',                      emoji: '🎯',  dotColor: '#3b82f6', metric: 'shotsOnGoal', unit: 'a puerta' },
      { key: 'shotsTotalists', data: shotsTotalists, label: 'Tiros totales',         hint: '(≥2 en 5+ de últimos 10)',                                 emoji: '💥', dotColor: '#60a5fa', metric: 'shotsTotal',  unit: 'tiros totales' },
      { key: 'assisters',      data: assisters,      label: 'Asistentes',            hint: '(asistencia en 5+ de últimos 10)',                          emoji: '🅰️',  dotColor: '#a78bfa', metric: 'assists',     unit: 'asistencias' },
      { key: 'foulers',        data: foulers,        label: 'Faltas frecuentes',     hint: '(falta cometida en 5+ de últimos 10)',                      emoji: '⚠️',  dotColor: '#f59e0b', metric: 'fouls',       unit: 'faltas' },
      { key: 'bookers',        data: bookers,        label: 'Tarjetas frecuentes',   hint: '(amarilla en 5+ de últimos 10)',                            emoji: '🟨',  dotColor: '#facc15', metric: 'yellows',     unit: 'amarillas' },
    ].filter(g => Array.isArray(g.data) && g.data.length > 0);
  }, [highlights]);

  if (!highlights || groups.length === 0) return null;
  const open = openSub === id;

  const PlayerRow = ({ pl, g }) => {
    const hist = pl[g.metric] || [];
    const total = g.metric === 'goals' ? pl.totalGoals
                : g.metric === 'shotsOnGoal' ? pl.totalShotsOn
                : g.metric === 'shotsTotal' ? pl.totalShotsAll
                : g.metric === 'assists' ? pl.totalAssists
                : g.metric === 'fouls' ? pl.totalFouls
                : pl.totalYellows;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', background: 'var(--bg-1)', border: '1px solid var(--brd)', borderRadius: 8, marginBottom: 4 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: '.82rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t1)' }}>{pl.name}</div>
          <div style={{ fontSize: '.65rem', color: 'var(--t3)' }}>{pl.teamName}</div>
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          {hist.slice(0, 10).map((n, j) => (
            <span key={j} style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 18, height: 18, borderRadius: 4,
              fontSize: '.62rem', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace',
              background: n > 0 ? g.dotColor : 'rgba(255,255,255,0.06)',
              color: n > 0 ? '#0f172a' : 'var(--t3)',
            }}>{n > 0 ? n : '—'}</span>
          ))}
        </div>
        <div style={{ fontSize: '.7rem', color: g.dotColor, fontWeight: 700, whiteSpace: 'nowrap', minWidth: 60, textAlign: 'right' }}>
          {total} {g.unit}
        </div>
      </div>
    );
  };

  return (
    <section className="subacc-section" style={{ '--subacc-accent': '#fbbf24' }}>
      <button
        type="button"
        className="subacc-trigger"
        onClick={(e) => toggleSubAndReveal(e, open, id, setOpenSub)}
        aria-expanded={open}
      >
        <span><i><Sparkles size={17} aria-hidden="true" /></i><strong>Jugadores destacados</strong></span>
        <ChevronDown className={open ? 'is-open' : ''} size={17} aria-hidden="true" />
      </button>
      <div className="subacc-grid" data-open={open ? '1' : '0'}>
        <div className="subacc-overflow">
          <div className="subacc-body">
            {groups.map(g => (
              <section key={g.key} className="subacc-group" style={{ '--subacc-group-accent': g.dotColor }}>
                <button
                  type="button"
                  className="subacc-group-trigger"
                  onClick={(e) => { e.stopPropagation(); setGrpOpen(prev => (prev === g.key ? null : g.key)); }}
                  aria-expanded={grpOpen === g.key}
                >
                  <span>{g.label}<small>{g.hint}</small></span>
                  <ChevronDown className={grpOpen === g.key ? 'is-open' : ''} size={16} aria-hidden="true" />
                </button>
                <div className="subacc-grid" data-open={grpOpen === g.key ? '1' : '0'}>
                  <div className="subacc-overflow">
                    <div className="subacc-player-list">
                      {g.data.slice(0, 5).map((pl, i) => <PlayerRow key={i} pl={pl} g={g} />)}
                    </div>
                  </div>
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </section>
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
        <TeamLogo src={teamLogo} name={teamName} size={32} />
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

/* ======================== SHARED ======================== */

function TeamLogo({ src, name, size = 96 }) {
  const [err, setErr] = useState(false);
  if (!src || err) {
    return (
      <div className="team-logo-fallback" style={{ width: size, height: size, fontSize: size * 0.4 }}>
        {(name || '?').slice(0, 2).toUpperCase()}
      </div>
    );
  }
  // Inline width/height para que el prop `size` mande sobre la regla CSS
  // .team-crest{width:24px} (la clase ganaba al atributo HTML y aplastaba
  // todos los escudos a 24px, invirtiendo la jerarquía vs logos de liga).
  return <img src={src} alt={name} className="team-crest" width={size} height={size} loading="lazy" decoding="async" style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0 }} onError={() => setErr(true)} />;
}

function getMinOdd(fixture, analyzedOdds) {
  const odds = analyzedOdds?.[fixture.fixture.id];
  if (!odds) return 0;
  return Math.min(odds.home || 99, odds.draw || 99, odds.away || 99);
}
