'use client';

/**
 * Baseball Dashboard — paleta amarillo tierra (amber-500/700/300).
 *
 * Estructura/perf clonada del de fútbol:
 *   - SWR llama `/api/baseball/fixtures?date=...&tz=<IANA>` → el backend
 *     devuelve los partidos cuyo kickoff cae en el día LOCAL del usuario.
 *     Esto cubre cross-midnight (game de 23:00 ET sigue vivo a 00:00 UTC).
 *   - Card pricipal y sub-acordeones usan CSS grid 0fr→1fr (compositor,
 *     150ms). Cero framer-motion en hot path (queda solo en ApuestaDelDia).
 *   - Sub-acordeones EXCLUSIVOS: solo uno abierto a la vez (Mercados o
 *     Probabilidades). El padre tiene `openSub` y los hijos lo togglean.
 *   - `toggleSubAndReveal` con scrollIntoView({block:'nearest'}) en doble
 *     rAF → el header del sub recién abierto siempre queda visible aunque
 *     el ResizeObserver de la lista haya movido el viewport.
 *
 * Source 100% PG VPS: el endpoint usa supabaseAdmin (= pgAdmin proxy).
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import Image from 'next/image';
import useSWR from 'swr';
import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Layers3,
  Sparkles,
  Target,
  Trash2,
  X,
} from 'lucide-react';
import { BASEBALL_FLAGS } from '../../../lib/baseball-leagues';
import {
  buildBaseballApuestaDelDia,
  buildCustomBaseballCombinada,
} from '../../../lib/baseball-combinada';
import { fetcher } from '../../../lib/fetcher';
import { usePusherEvent } from '../../../lib/use-pusher';
import { DateCaption, LeaguePicker, StatusPicker } from '../components/DashboardFilters';
import DashboardBuffer from '../components/DashboardBuffer';
import AnalysisFullModal from '../components/AnalysisFullModal';
import { displayBettingText } from '../utils/display-betting-text';
import { BASEBALL_RECOMMENDATION_MIN_PROBABILITY } from '../../../lib/recommendation-policy';

const BaseballAnalysisExperience = dynamic(
  () => import('./analisis/[id]/page').then((module) => module.BaseballAnalysisExperience),
  {
    ssr: false,
    loading: () => <DashboardBuffer compact />,
  },
);

// =====================================================================
// HELPERS
// =====================================================================
const cap = (v) => {
  const value = Math.max(0, Math.min(100, Number(v) || 0));
  if (value >= 95) return 95;
  return Math.floor((value + 1e-9) * 100) / 100;
};
const normalizeBookmaker = (value) => String(value || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const bet365Markets = (analysis) => (Array.isArray(analysis?.combinada?.selectable)
  ? analysis.combinada.selectable
  : [])
  .filter((market) => normalizeBookmaker(market.bookmaker) === 'bet365'
    && Number(market.odd) >= 1.20
    && Number(market.rawProbability ?? market.probability) >= BASEBALL_RECOMMENDATION_MIN_PROBABILITY)
  .sort((a, b) => Number(b.rawProbability ?? b.probability) - Number(a.rawProbability ?? a.probability)
    || Number(b.odd) - Number(a.odd));
const isLive = (s) => ['LIVE', 'IN', 'IN1', 'IN2', 'IN3', 'IN4', 'IN5', 'IN6', 'IN7', 'IN8', 'IN9'].includes(s);
const isFinished = (s) => ['FT', 'AOT'].includes(s);
const isPostponed = (s) => ['POST', 'CANC', 'INTR', 'ABD'].includes(s);

const detectTz = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
};
const todayInTz = (tz) => {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: tz }); }
  catch { return new Date().toISOString().split('T')[0]; }
};
const fmtTimeInTz = (iso, tz = 'UTC') => {
  if (!iso) return '–';
  try {
    return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  } catch {
    return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  }
};
const fmtDateLabel = (date) => {
  try {
    return new Date(`${date}T12:00:00`).toLocaleDateString('es-ES', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  } catch {
    return date;
  }
};
const statusText = (g) => {
  const s = g?.status?.short;
  if (isLive(s)) {
    const inning = g?.status?.inning ?? '';
    const half = (g?.status?.long || '').toLowerCase();
    const arrow = half.includes('top') ? '↑' : half.includes('bottom') ? '↓' : '';
    return `${arrow}${inning}`.trim() || 'EN VIVO';
  }
  if (isFinished(s)) return 'FIN';
  if (isPostponed(s)) return s === 'POST' ? 'POSP' : s === 'CANC' ? 'CANC' : s;
  return 'PRÓX';
};

// Toggle de sub-acordeón + revelado del header. Mismo helper que fútbol:
// al abrir un sub, el ResizeObserver del card puede mover el item; en doble
// rAF lo dejamos asentarse y traemos el header de vuelta con
// scrollIntoView({block:'nearest'}) — solo mueve si quedó fuera de vista.
function toggleSubAndReveal(e, isOpen, id, setOpenSub) {
  e.stopPropagation();
  const header = e.currentTarget;
  setOpenSub(isOpen ? null : id);
  if (!isOpen && header) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try { header.scrollIntoView({ block: 'nearest' }); } catch {}
    }));
  }
}

// =====================================================================
// DASHBOARD
// =====================================================================
export default function BaseballDashboard() {
  // userTz/date arrancan en UTC (SSR) y se corrigen a la TZ REAL del navegador
  // en el cliente (useEffect). Sin esto, el initializer corría en SSR → UTC y
  // se quedaba en UTC para siempre → el frontend mostraba todo en horario UTC.
  // Mismo patrón que el dashboard de fútbol.
  const [userTz, setUserTz] = useState('UTC');
  const [tab, setTab] = useState('partidos');
  const [date, setDate] = useState(() => todayInTz('UTC'));
  useEffect(() => {
    const tz = detectTz();
    setUserTz(tz);
    setDate(todayInTz(tz));
  }, []);
  const [sortBy] = useState('time');
  const [statusFilter, setStatusFilter] = useState('all');
  const [leagueFilter, setLeagueFilter] = useState('');
  const [expandedMatch, setExpandedMatch] = useState(null);
  const [showApuesta, setShowApuesta] = useState(true);
  const [error, setError] = useState('');
  const [analysisModalId, setAnalysisModalId] = useState(null);

  // Custom combinada — manual selections by user
  const [selectedMarkets, setSelectedMarkets] = useState({});

  // ─── SWR: fixtures (con tz del cliente) ────────────────────────────
  // El endpoint con ?tz= pide 3 fechas UTC adyacentes a la fuente y filtra
  // al día local del usuario. Si abres a las 9am España, ves los games cuya
  // hora local española cae entre 00:00 y 23:59 ES — igual que fútbol.
  const fixturesKey = date
    ? `/api/baseball/fixtures?date=${date}&tz=${encodeURIComponent(userTz)}`
    : null;
  const { data: fxData, mutate: fixturesMutate, isLoading: loadingFixtures } = useSWR(
    fixturesKey,
    fetcher,
    {
      refreshInterval: (latest) => latest?.fixtures?.some((fixture) => !fixture.isAnalyzed) ? 5_000 : 60_000,
      revalidateOnFocus: true,
      dedupingInterval: 5000,
      keepPreviousData: true,
    },
  );

  // ─── Estado EN VIVO por WebSocket ──────────────────────────────────
  // El worker (baseball-live) emite 'baseball-live'/'update' con el estado
  // pitch-by-pitch de cada juego MLB en curso. Lo aplicamos sobre los games
  // del SWR para actualización instantánea (sin esperar al refresh de 60s).
  const [liveOverrides, setLiveOverrides] = useState({});
  usePusherEvent('baseball-live', 'update', useCallback((data) => {
    if (!data?.games) return;
    setLiveOverrides(prev => {
      const next = { ...prev };
      for (const s of data.games) {
        if (!s?.gamePk) continue;
        next[s.gamePk] = {
          status: s.isFinal ? 'FT' : (s.isLive ? 'IN' : 'NS'),
          inning: s.inning ?? null,
          inning_half: s.inningHalf ? String(s.inningHalf).toLowerCase() : null,
          home_score: s.home?.runs ?? s.home?.score ?? null,
          away_score: s.away?.runs ?? s.away?.score ?? null,
          // Estado rico para la UI en vivo (conteo, bases, pitcher/bateador).
          outs: s.outs, balls: s.balls, strikes: s.strikes, bases: s.bases,
          currentPitcher: s.currentPitcher, currentBatter: s.currentBatter,
          lastPlay: s.lastPlay,
        };
      }
      return next;
    });
  }, []));

  const rawGames = fxData?.fixtures || [];
  // Aplicar overrides en vivo sobre el liveResult de cada juego.
  const games = Object.keys(liveOverrides).length === 0
    ? rawGames
    : rawGames.map(g => {
        const ov = liveOverrides[g.id];
        return ov ? { ...g, liveResult: { ...(g.liveResult || {}), ...ov } } : g;
      });
  const hidden = games.filter(g => g.isHidden).map(g => g.id);
  const favorites = games.filter(g => g.isFavorite).map(g => g.id);
  const analyzed = games.filter(g => g.isAnalyzed).map(g => g.id);
  const loading = loadingFixtures && games.length === 0;

  // ─── ACTIONS ────────────────────────────────────────────────────────
  const changeDate = (offset) => {
    const [y, m, d] = date.split('-').map(Number);
    const nd = new Date(y, m - 1, d + offset);
    const dStr = `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, '0')}-${String(nd.getDate()).padStart(2, '0')}`;
    setDate(dStr);
    setSelectedMarkets({});
    setExpandedMatch(null);
  };

  // Optimistic dismiss + favorite con rollback
  const dismissMatch = async (e, fixtureId) => {
    e.stopPropagation();
    setSelectedMarkets(prev => { const n = { ...prev }; delete n[fixtureId]; return n; });
    fixturesMutate(prev => prev && ({
      ...prev,
      fixtures: prev.fixtures.map(g => g.id === fixtureId ? { ...g, isHidden: true } : g),
    }), { revalidate: false });
    try {
      const res = await fetch('/api/baseball/hidden', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId, date, action: 'hide' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error('[baseball:hide] rollback:', err.message);
      fixturesMutate();
      setError('No se pudo ocultar el partido — restaurado.');
    }
  };

  const toggleFavorite = async (e, fixtureId) => {
    e.stopPropagation();
    const isFav = favorites.includes(fixtureId);
    fixturesMutate(prev => prev && ({
      ...prev,
      fixtures: prev.fixtures.map(g => g.id === fixtureId ? { ...g, isFavorite: !isFav } : g),
    }), { revalidate: false });
    try {
      const res = await fetch('/api/baseball/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId, action: isFav ? 'remove' : 'add' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error('[baseball:fav] rollback:', err.message);
      fixturesMutate();
      setError('No se pudo guardar el favorito — restaurado.');
    }
  };

  // Market selection (custom combinada)
  const toggleMarket = (fixtureId, marketKey, marketData) => {
    setSelectedMarkets(prev => {
      const fixMarkets = { ...(prev[fixtureId] || {}) };
      if (fixMarkets[marketKey]) delete fixMarkets[marketKey];
      else fixMarkets[marketKey] = marketData;
      const next = { ...prev };
      if (Object.keys(fixMarkets).length === 0) delete next[fixtureId];
      else next[fixtureId] = fixMarkets;
      return next;
    });
  };

  const totalSel = Object.values(selectedMarkets).reduce((s, m) => s + Object.keys(m).length, 0);

  const customCombinada = useMemo(() => {
    const gamesById = Object.fromEntries(games.map(g => [g.id, g]));
    return buildCustomBaseballCombinada(selectedMarkets, gamesById);
  }, [selectedMarkets, games]);

  // ─── DERIVED ────────────────────────────────────────────────────────
  const visible = useMemo(() => games.filter(g => {
    if (hidden.includes(g.id)) return false;
    const s = g.status?.short;
    if (isPostponed(s)) return false;
    if (statusFilter === 'live' && !isLive(s)) return false;
    if (statusFilter === 'upcoming' && s !== 'NS') return false;
    if (statusFilter === 'finished' && !isFinished(s)) return false;
    if (statusFilter === 'favoritos' && !favorites.includes(g.id)) return false;
    if (leagueFilter && String(g.league?.id) !== leagueFilter) return false;
    return true;
  }), [games, hidden, statusFilter, leagueFilter, favorites]);

  const sorted = useMemo(() => {
    const arr = [...visible];
    if (sortBy === 'time') return arr.sort((a, b) => new Date(a.date) - new Date(b.date));
    if (sortBy === 'probability') {
      return arr.sort((a, b) => {
        const aA = analyzed.includes(a.id) ? 1 : 0;
        const bA = analyzed.includes(b.id) ? 1 : 0;
        if (aA !== bA) return bA - aA;
        const aP = a.analysis?.combinada?.combinedProbability || 0;
        const bP = b.analysis?.combinada?.combinedProbability || 0;
        if (aP !== bP) return bP - aP;
        return new Date(a.date) - new Date(b.date);
      });
    }
    return arr;
  }, [visible, sortBy, analyzed]);

  const analyzedGames = useMemo(
    () => games.filter(g => analyzed.includes(g.id) && !hidden.includes(g.id) && g.analysis),
    [games, analyzed, hidden],
  );

  const apuestaDelDia = useMemo(() => buildBaseballApuestaDelDia(analyzedGames), [analyzedGames]);

  const liveCount = games.filter(g => !hidden.includes(g.id) && isLive(g.status?.short)).length;
  const upcomingCount = games.filter(g => !hidden.includes(g.id) && g.status?.short === 'NS').length;
  const finishedCount = games.filter(g => !hidden.includes(g.id) && isFinished(g.status?.short)).length;
  const favoriteCount = games.filter(g => favorites.includes(g.id) && !hidden.includes(g.id)).length;
  const allVisibleCount = games.filter((game) => {
    if (hidden.includes(game.id)) return false;
    if (isPostponed(game.status?.short)) return false;
    if (leagueFilter && String(game.league?.id) !== leagueFilter) return false;
    return true;
  }).length;

  const leagueOptions = useMemo(() => {
    const map = new Map();
    for (const g of games) {
      if (hidden.includes(g.id)) continue;
      if (!g.league?.id) continue;
      map.set(g.league.id, {
        id: g.league.id,
        name: g.league.name,
        country: g.country?.name || g.leagueMeta?.country,
        logo: g.league.logo,
      });
    }
    return Array.from(map.values()).sort((a, b) => (a.country || '').localeCompare(b.country || ''));
  }, [games, hidden]);

  const groupedByLeague = useMemo(() => {
    const groups = {};
    for (const g of sorted) {
      const k = g.league?.id || 0;
      if (!groups[k]) {
        groups[k] = {
          leagueId: g.league?.id,
          leagueName: g.league?.name,
          country: g.country?.name || g.leagueMeta?.country,
          games: [],
        };
      }
      groups[k].games.push(g);
    }
    return Object.values(groups);
  }, [sorted]);

  // ─── RENDER ─────────────────────────────────────────────────────────
  return (
    <div className="app app-fade-in">
      <div className="container app-baseball">
      <div className="controls-row baseball-controls">
        <div className="date-nav baseball-date-nav">
        <button className="baseball-control-btn" onClick={() => changeDate(-1)} aria-label="Día anterior"><ChevronLeft size={17} aria-hidden="true" /></button>
        <label className="date-picker-label">
          <DateCaption isToday={date === todayInTz(userTz)} label={fmtDateLabel(date)} />
          <input
            type="date"
            value={date}
            onChange={(e) => { setDate(e.target.value); setSelectedMarkets({}); }}
          />
        </label>
        <button className="baseball-control-btn" onClick={() => changeDate(1)} aria-label="Día siguiente"><ChevronRight size={17} aria-hidden="true" /></button>
        {date !== todayInTz(userTz) && (
          <button className="baseball-today-btn" onClick={() => setDate(todayInTz(userTz))}><CalendarDays size={14} aria-hidden="true" /> Hoy</button>
        )}
        </div>

        <div className="filters-row baseball-filter-row">
          <LeaguePicker
            leagues={leagueOptions}
            value={leagueFilter}
            onChange={setLeagueFilter}
          />
        </div>
      </div>

      <div className="tabs baseball-tabs">
        <button className={`tab ${tab === 'partidos' ? 'active is-active' : ''}`} onClick={() => setTab('partidos')}>
          Partidos
          {allVisibleCount > 0 && <span>{allVisibleCount}</span>}
        </button>
        <button className={`tab ${tab === 'combinada' ? 'active is-active' : ''}`} onClick={() => setTab('combinada')}>
          Combinada
          {totalSel > 0 && <span>{totalSel}</span>}
        </button>
        <StatusPicker
          value={statusFilter}
          onChange={setStatusFilter}
          counts={{
            all: allVisibleCount,
            live: liveCount,
            upcoming: upcomingCount,
            finished: finishedCount,
            favorites: favoriteCount,
          }}
        />
      </div>

      {apuestaDelDia && tab === 'partidos' && (
        <ApuestaDelDiaBlock apuesta={apuestaDelDia} show={showApuesta} onToggle={() => setShowApuesta(!showApuesta)} />
      )}

      {error && (
        <div style={{
          padding: 12, borderRadius: 10, marginBottom: 14,
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5',
        }}>{error}</div>
      )}

      {loading ? (
        <DashboardBuffer compact />
      ) : (
        <>
          {tab === 'partidos' && (
            <div className="bb-list">
              {sorted.length === 0 ? (
                <EmptyState />
              ) : (
                groupedByLeague.map(group => (
                  <LeagueGroup
                    key={group.leagueId}
                    group={group}
                    userTz={userTz}
                    favorites={favorites}
                    analyzed={analyzed}
                    expandedMatch={expandedMatch}
                    onExpand={(id) => setExpandedMatch(expandedMatch === id ? null : id)}
                    onFavorite={toggleFavorite}
                    onDismiss={dismissMatch}
                    onViewFull={setAnalysisModalId}
                    selectedMarkets={selectedMarkets}
                    onToggleMarket={toggleMarket}
                  />
                ))
              )}
            </div>
          )}

          {tab === 'combinada' && (
            <CombinadaTab
              customCombinada={customCombinada}
              onClear={() => setSelectedMarkets({})}
              onRemove={(fid, key) => {
                setSelectedMarkets(prev => {
                  const n = { ...prev };
                  if (n[fid]) {
                    delete n[fid][key];
                    if (Object.keys(n[fid]).length === 0) delete n[fid];
                  }
                  return n;
                });
              }}
            />
          )}
        </>
      )}

      {tab !== 'combinada' && totalSel > 0 && (
        <button
          className="baseball-comb-action"
          onClick={() => setTab('combinada')}
        >
          <span><Layers3 size={18} aria-hidden="true" /></span>
          <span><small>Tu selección</small><strong>Mi combinada · {totalSel}</strong></span>
          <ArrowRight size={18} aria-hidden="true" />
        </button>
      )}

      {analysisModalId && (
        <BaseballAnalysisModal id={analysisModalId} onClose={() => setAnalysisModalId(null)} />
      )}
      </div>
    </div>
  );
}

function BaseballAnalysisModal({ id, onClose }) {
  return (
    <AnalysisFullModal
      onClose={onClose}
      variant="baseball"
      bodyClassName="baseball-analysis-modal-body"
      ariaLabel="Análisis completo de baseball"
    >
      <BaseballAnalysisExperience fixtureId={id} embedded onClose={onClose} />
    </AnalysisFullModal>
  );
}

// =====================================================================
// LEAGUE GROUP + GAME CARD (con acordeón inline cuando isAnalyzed)
// =====================================================================
function LeagueGroup({ group, userTz, favorites, analyzed, expandedMatch,
                      onExpand, onFavorite, onDismiss, onViewFull, selectedMarkets, onToggleMarket }) {
  return (
    <div className="baseball-league-group" style={{ marginBottom: 22 }}>
      <h3 className="baseball-league-heading" style={{
        fontSize: '.92rem', fontWeight: 800, color: '#cbd5e1',
        margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 6,
        borderBottom: '1px solid rgba(94,230,177,0.18)',
      }}>
        <span>{BASEBALL_FLAGS[group.country] || '🌍'}</span>
        <span style={{ color: '#94a3b8' }}>{group.country}</span>
        <span style={{ color: '#5ee6b1' }}>·</span>
        <span style={{ color: '#bff4df' }}>{group.leagueName}</span>
        <span style={{ marginLeft: 'auto', fontSize: '.7rem', color: '#64748b', fontWeight: 600 }}>
          {group.games.length} {group.games.length === 1 ? 'partido' : 'partidos'}
        </span>
      </h3>
      <div style={{ display: 'grid', gap: 8 }}>
        {group.games.map(g => (
          <GameCard
            key={g.id}
            game={g}
            userTz={userTz}
            isFavorite={favorites.includes(g.id)}
            isAnalyzed={analyzed.includes(g.id)}
            isExpanded={expandedMatch === g.id}
            onExpand={() => onExpand(g.id)}
            onFavorite={onFavorite}
            onDismiss={onDismiss}
            onViewFull={() => onViewFull(g.id)}
            selectedMarkets={selectedMarkets[g.id] || {}}
            onToggleMarket={(key, data) => onToggleMarket(g.id, key, data)}
          />
        ))}
      </div>
    </div>
  );
}

// Base del diamante (rombo) posicionada en el contenedor 40x40.
const diamondBase = (occupied, left, top) => ({
  position: 'absolute', width: 12, height: 12, left, top,
  transform: 'translate(-50%,-50%) rotate(45deg)', borderRadius: 2,
  background: occupied ? '#5ee6b1' : 'rgba(255,255,255,0.12)',
  boxShadow: occupied ? '0 0 6px rgba(94,230,177,0.6)' : 'none',
  transition: 'background .3s, box-shadow .3s',
});

// Estado EN VIVO tipo bet365: diamante de bases, conteo bolas-strikes, outs,
// inning y pitcher/bateador actuales. Datos del WS 'baseball-live' (liveResult).
function LiveDiamond({ live }) {
  const b = live.bases || {};
  const balls = live.balls ?? 0;
  const strikes = live.strikes ?? 0;
  const outs = live.outs ?? 0;
  const arrow = live.inning_half === 'top' ? '↑' : live.inning_half === 'bottom' ? '↓' : '';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(94,230,177,0.06)', border: '1px solid rgba(94,230,177,0.16)' }}>
      <div style={{ position: 'relative', width: 40, height: 40, flexShrink: 0 }}>
        <span style={diamondBase(b.second, '50%', '22%')} />
        <span style={diamondBase(b.third, '22%', '50%')} />
        <span style={diamondBase(b.first, '78%', '50%')} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontFamily: 'JetBrains Mono, monospace' }}>
        <span style={{ fontSize: '.72rem', color: '#5ee6b1', fontWeight: 800 }}>
          {arrow}{live.inning ?? ''}  ·  {balls}-{strikes}
        </span>
        <span style={{ fontSize: '.64rem', color: '#bff4df', letterSpacing: 1 }}>
          {'●'.repeat(Math.min(outs, 3))}{'○'.repeat(Math.max(0, 2 - outs))} outs
        </span>
      </div>
      {(live.currentPitcher?.name || live.currentBatter?.name) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: '.62rem', color: '#94a3b8', minWidth: 0, flex: 1 }}>
          {live.currentPitcher?.name && <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>⚾ {live.currentPitcher.name}</span>}
          {live.currentBatter?.name && <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>🏏 {live.currentBatter.name}</span>}
        </div>
      )}
    </div>
  );
}

// Foto oficial del jugador MLB (headshot) por su id.
const pitcherFace = (id) => id
  ? `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_120,q_auto:best/v1/people/${id}/headshot/67/current`
  : null;

// Columna de equipo: logo grande + abreviatura + pitcher abridor (foto + ERA).
function TeamColumn({ team, pitcherName, pitcherId, era, role, winProbability }) {
  const short = pitcherName ? pitcherName.split(' ').slice(-1)[0] : null;
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <span style={{
        padding: '3px 7px', borderRadius: 8,
        background: role === 'LOCAL' ? 'rgba(34,211,238,.10)' : 'rgba(245,158,11,.10)',
        border: `1px solid ${role === 'LOCAL' ? 'rgba(34,211,238,.25)' : 'rgba(245,158,11,.25)'}`,
        color: role === 'LOCAL' ? '#67e8f9' : '#fcd34d',
        fontSize: '.56rem', fontWeight: 900, letterSpacing: '.06em',
        display: 'inline-flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.25,
      }}>
        <span>{role}</span>
        {winProbability != null && <span style={{ letterSpacing: 0 }}>Gana {cap(winProbability)}%</span>}
      </span>
      {team?.logo
        ? <Image src={team.logo} alt={team.name} width={46} height={46} style={{ objectFit: 'contain' }} unoptimized />
        : <div style={{ width: 46, height: 46, borderRadius: 10, background: 'rgba(255,255,255,.06)' }} />}
      <span style={{ fontSize: '.86rem', fontWeight: 800, color: '#f1f5f9', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
        {team?.abbreviation || team?.name}
      </span>
      {short && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '2px 7px 2px 2px', borderRadius: 999, background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.07)', maxWidth: '100%' }}>
          {pitcherId
            ? <Image src={pitcherFace(pitcherId)} alt={pitcherName} width={22} height={22} style={{ borderRadius: '50%', objectFit: 'cover', background: 'rgba(255,255,255,.08)' }} unoptimized />
            : <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'rgba(255,255,255,.08)', display: 'inline-block' }} />}
          <span style={{ fontSize: '.6rem', color: '#cbd5e1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {short}{era ? ` · ${era}` : ''}
          </span>
        </div>
      )}
    </div>
  );
}

// Marcador central / hora + badge de estado (estilo score-box de fútbol).
function ScoreCenter({ live, hasScore, homeScore, awayScore, statusLabel, time, inningTxt }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, minWidth: 92 }}>
      {live ? (
        <span className="ap2-live-badge live-badge-glow" style={{ fontSize: '.62rem' }}>
          <span className="ap2-live-dot live-dot-pulse" /> {inningTxt || 'EN VIVO'}
        </span>
      ) : (
        <span style={{ padding: '3px 10px', borderRadius: 999, background: 'rgba(255,255,255,.08)', fontSize: '.62rem', fontWeight: 800, color: '#bff4df', letterSpacing: '.05em', fontFamily: 'JetBrains Mono, monospace' }}>
          {statusLabel}
        </span>
      )}
      {hasScore ? (
        <div style={{ fontSize: 'clamp(1.7rem,6vw,2.4rem)', fontWeight: 800, color: '#f1f5f9', fontFamily: 'JetBrains Mono, monospace', lineHeight: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{homeScore}</span>
          <span style={{ color: 'rgba(255,255,255,.25)', fontSize: '1.2rem' }}>-</span>
          <span>{awayScore}</span>
        </div>
      ) : (
        <span style={{ fontSize: '1.05rem', fontWeight: 800, color: '#bff4df', fontFamily: 'JetBrains Mono, monospace' }}>{time}</span>
      )}
    </div>
  );
}

function GameCard({ game, userTz, isFavorite, isAnalyzed, isExpanded,
                    onExpand, onFavorite, onDismiss, onViewFull,
                    selectedMarkets, onToggleMarket }) {
  // Estado EXCLUSIVO de sub-acordeón (solo uno abierto: Mercados o Probabilidades).
  const [openSub, setOpenSub] = useState(null);

  const home = game.teams?.home;
  const away = game.teams?.away;
  const liveResult = game.liveResult;
  // El estado y el marcador FRESCOS viven en baseball_match_results (liveResult):
  // el job live los actualiza incluso al terminar el partido (FT). game.status
  // viene del snapshot matutino de fixtures (NS, 0-0), así que SIEMPRE preferimos
  // liveResult cuando existe — si no, un partido terminado se vería como "próximo"
  // o con 0-0 hasta que el finalize nocturno refresque el cache.
  const effStatus = liveResult?.status || game.status?.short;
  const live = isLive(effStatus);
  const finished = isFinished(effStatus);
  const homeScore = liveResult?.home_score ?? game.scores?.home?.total;
  const awayScore = liveResult?.away_score ?? game.scores?.away?.total;
  const hasScore = (live || finished) && homeScore != null && awayScore != null;
  // Status efectivo para statusText (incluye inning/half del liveResult).
  const effStatusObj = liveResult
    ? {
        short: liveResult.status,
        inning: liveResult.inning,
        long: liveResult.inning_half === 'top' ? 'Top'
            : liveResult.inning_half === 'bottom' ? 'Bottom' : '',
      }
    : game.status;

  const combinada = game.analysis?.combinada;
  const winProbabilities = combinada?.winProbabilities;
  const availableMarkets = bet365Markets(game.analysis);

  // Pitchers abridores (foto + ERA) y cuotas reales (moneyline) para el header.
  const pp = game.probablePitchers || {};
  const pm = game.analysis?.analysis?.pitcherMatchup || {};
  const homeEra = pm.home?.stats?.era != null ? Number(pm.home.stats.era).toFixed(2) : null;
  const awayEra = pm.away?.stats?.era != null ? Number(pm.away.stats.era).toFixed(2) : null;
  const bestOdds = game.analysis?.best_odds || null;

  const handleCardClick = (e) => {
    if (e.target.closest('button')) return;
    onExpand();
  };

  const cardClass = [
    'bb-card',
    isExpanded ? 'open' : '',
    live ? 'live' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cardClass}>
      <div className="bb-head" onClick={handleCardClick}>
        {/* Fila: liga + fecha + favorito */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <span style={{ fontSize: '.78rem', fontWeight: 700, color: '#f1f5f9', display: 'flex', alignItems: 'center', gap: 6 }}>⚾ MLB</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '.72rem', color: 'rgba(255,255,255,.55)' }}>{fmtTimeInTz(game.date, userTz)}</span>
            <button
              onClick={(e) => onFavorite(e, game.id)}
              style={{
                width: 26, height: 26, borderRadius: 6, border: '1px solid rgba(94,230,177,0.25)',
                background: isFavorite ? 'rgba(94,230,177,0.18)' : 'transparent',
                color: isFavorite ? '#5ee6b1' : '#94a3b8', cursor: 'pointer', fontSize: 14,
              }}
            >★</button>
          </div>
        </div>

        {/* Equipos + marcador central (estilo fútbol) con pitchers MLB (foto+ERA) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <TeamColumn
            team={home} pitcherName={pp.home} pitcherId={pp.homeId} era={homeEra}
            role="LOCAL" winProbability={winProbabilities?.home}
          />
          <ScoreCenter
            live={live} hasScore={hasScore} homeScore={homeScore} awayScore={awayScore}
            statusLabel={statusText({ status: effStatusObj })}
            time={fmtTimeInTz(game.date, userTz)}
            inningTxt={live ? statusText({ status: effStatusObj }) : null}
          />
          <TeamColumn
            team={away} pitcherName={pp.away} pitcherId={pp.awayId} era={awayEra}
            role="VISITANTE" winProbability={winProbabilities?.away}
          />
        </div>

        {/* Estado EN VIVO: diamante de bases + conteo (solo en curso) */}
        {live && liveResult && (liveResult.inning != null || liveResult.bases) && (
          <LiveDiamond live={liveResult} />
        )}

        {/* Cuotas reales a color (moneyline) */}
        {bestOdds?.moneyline && (bestOdds.moneyline.home != null || bestOdds.moneyline.away != null) && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ padding: '2px 6px', borderRadius: 999, background: '#f5e400', color: '#10241e', fontSize: '.58rem', fontWeight: 900 }}>BET365</span>
            {bestOdds.moneyline.home != null && (
              <span style={{ padding: '4px 14px', borderRadius: 8, background: 'linear-gradient(135deg,#22c55e,#16a34a)', fontWeight: 700, fontSize: '.8rem', color: '#fff' }}>
                {home?.abbreviation || 'Local'} {Number(bestOdds.moneyline.home).toFixed(2)}
              </span>
            )}
            {bestOdds.moneyline.away != null && (
              <span style={{ padding: '4px 14px', borderRadius: 8, background: 'linear-gradient(135deg,#ef4444,#dc2626)', fontWeight: 700, fontSize: '.8rem', color: '#fff' }}>
                {away?.abbreviation || 'Visit.'} {Number(bestOdds.moneyline.away).toFixed(2)}
              </span>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {availableMarkets.slice(0, 2).map((market) => (
            <span key={market.id} style={miniChip()}>
              Bet365 · {displayBettingText(market.name)} · {cap(market.rawProbability ?? market.probability)}% @{Number(market.odd).toFixed(2)}
            </span>
          ))}

          {combinada?.selections?.length > 0 && combinada.combinedProbability >= 60 && (
            <span style={miniChip()}>
              🎯 Combinada {combinada.selections?.length || 0} picks · {cap(combinada.combinedProbability)}%
              {combinada.combinedOdd ? ` @${combinada.combinedOdd}` : ''}
            </span>
          )}
          {isAnalyzed && availableMarkets.length === 0 && (
            <span style={miniChip()}>Sin recomendación disponible en Bet365</span>
          )}
          {isAnalyzed && (
            <span style={miniChip()}>
              {isExpanded ? 'Ocultar análisis ▲' : 'Ver análisis ▼'}
            </span>
          )}
          {!isAnalyzed && (
            <span style={miniChip()}>Preparando análisis automático…</span>
          )}
          <span style={{ flex: 1 }} />
          <button
            onClick={(e) => onDismiss(e, game.id)}
            style={{
              width: 24, height: 24, borderRadius: 6,
              background: 'transparent', color: '#94a3b8', cursor: 'pointer',
              border: '1px solid rgba(255,255,255,0.08)', fontSize: 11,
            }}
          >✕</button>
        </div>
      </div>

      {/* Acordeón principal con CSS grid 0fr→1fr — sub-acordeones siempre
          MONTADOS en el DOM (toggle solo cambia data-open). Apertura
          instantánea garantizada incluso la primera vez. */}
      <div className="bb-grid" data-open={isExpanded ? '1' : '0'}>
        <div>
          <div style={{ padding: 12 }}>
            {!isAnalyzed && (
              <div role="status" style={{
                padding: '14px 12px', borderRadius: 10, textAlign: 'center',
                background: 'rgba(94,230,177,0.06)', border: '1px solid rgba(94,230,177,0.18)',
                color: '#bff4df', fontSize: '.78rem', fontWeight: 700,
              }}>
                Actualizando el análisis automáticamente. Esta tarjeta se habilitará en cuanto termine.
              </div>
            )}
            {isAnalyzed && combinada && (
              <>
                <SubAccordion
                  id="markets"
                  title="Mercados para tu combinada"
                  icon={Layers3}
                  color="#5ee6b1"
                  openSub={openSub}
                  setOpenSub={setOpenSub}
                  defaultOpen
                >
                  <BaseballMarketsBlock
                    game={game}
                    selectedMarkets={selectedMarkets}
                    onToggleMarket={onToggleMarket}
                  />
                </SubAccordion>

                <SubAccordion
                  id="probs"
                  title="Probabilidades calculadas"
                  color="#5ee6b1"
                  openSub={openSub}
                  setOpenSub={setOpenSub}
                >
                  <BaseballProbBlock
                    markets={availableMarkets}
                  />
                </SubAccordion>

                <button className="baseball-view-full" onClick={onViewFull}>
                  <span><small>Explora cada indicador</small><strong>Ver análisis completo</strong></span>
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TeamLine({ team, score, winner, live }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0',
      color: winner ? '#bff4df' : '#cbd5e1', fontWeight: winner ? 700 : 500,
    }}>
      {team?.logo
        ? <Image src={team.logo} alt={team.name} width={20} height={20} style={{ objectFit: 'contain' }} unoptimized />
        : <span style={{ width: 20, height: 20, background: 'rgba(255,255,255,0.06)', borderRadius: 4 }} />}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '.9rem' }}>{team?.name || '–'}</span>
      {score != null && (
        <span className={`bb-score ${live ? 'live' : ''}`}>
          {score}
        </span>
      )}
    </div>
  );
}

// =====================================================================
// SUB-ACORDEÓN EXCLUSIVO (CSS grid 0fr→1fr, 150ms en compositor)
// Children siempre montados → toggle = solo cambio de atributo.
// =====================================================================
function SubAccordion({ id, title, color, icon: Icon = BarChart3, openSub, setOpenSub, defaultOpen, children }) {
  // Si openSub nunca se ha tocado (null) y este sub tiene defaultOpen, lo
  // tratamos como abierto. Pero en cuanto el usuario toggle CUALQUIER sub,
  // el padre setea openSub a algo no-null y la regla deja de aplicar.
  const isOpen = openSub === id || (openSub === null && !!defaultOpen);
  return (
    <section className="subacc-section is-baseball" style={{ '--subacc-accent': color || '#5ee6b1' }}>
      <button
        type="button"
        className="subacc-trigger"
        onClick={(e) => toggleSubAndReveal(e, isOpen, id, setOpenSub)}
        aria-expanded={isOpen}
      >
        <span><i><Icon size={17} aria-hidden="true" /></i><strong>{title}</strong></span>
        <ChevronDown className={isOpen ? 'is-open' : ''} size={17} aria-hidden="true" />
      </button>
      <div className="subacc-grid" data-open={isOpen ? '1' : '0'}>
        <div className="subacc-overflow">
          <div className="subacc-body">{children}</div>
        </div>
      </div>
    </section>
  );
}

// =====================================================================
// BLOQUES BET365 — la lista persistida por el servidor es la única fuente.
// No se reconstruyen líneas desde probabilidades ni se muestran referencias.
// =====================================================================
function groupBet365Markets(markets) {
  return (markets || []).reduce((groups, market) => {
    const label = market.marketLabel || market.market || 'Mercado Bet365';
    (groups[label] ||= []).push(market);
    return groups;
  }, {});
}

function BaseballMarketsBlock({ game, selectedMarkets, onToggleMarket }) {
  const markets = bet365Markets(game.analysis);
  if (markets.length === 0) {
    return (
      <div style={{ fontSize: '.78rem', color: '#94a3b8', lineHeight: 1.5 }}>
        Bet365 no tiene ahora una selección compatible con el modelo, probabilidad mínima del {BASEBALL_RECOMMENDATION_MIN_PROBABILITY}% y cuota mínima de 1,20 para este partido.
      </div>
    );
  }

  return (
    <div>
      {Object.entries(groupBet365Markets(markets)).map(([category, items]) => (
        <div key={category} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
            <span style={{ padding: '2px 6px', borderRadius: 999, background: '#f5e400', color: '#10241e', fontSize: '.58rem', fontWeight: 900 }}>BET365</span>
            <span style={{ fontSize: '.7rem', color: '#5ee6b1', fontWeight: 800, letterSpacing: .5, textTransform: 'uppercase' }}>{category}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 6 }}>
            {items.map((market) => {
              const key = market.id;
              const selected = !!selectedMarkets[key];
              const marketData = {
                ...market,
                key,
                cat: category,
                label: market.name,
                probability: cap(market.probability),
                rawProbability: Number(market.rawProbability ?? market.probability),
                odd: Number(market.odd),
              };
              return (
                <button
                  key={key}
                  onClick={() => onToggleMarket(key, marketData)}
                  style={{
                    padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                    background: selected ? 'rgba(94,230,177,0.16)' : 'rgba(255,255,255,0.03)',
                    border: selected ? '1px solid #5ee6b1' : '1px solid rgba(94,230,177,0.10)',
                    textAlign: 'left', display: 'grid', gridTemplateColumns: '16px 1fr auto', alignItems: 'center', gap: 7,
                  }}
                >
                  <span style={{
                    width: 14, height: 14, borderRadius: 3,
                    background: selected ? '#5ee6b1' : 'transparent',
                    border: selected ? 'none' : '1px solid #475569',
                    color: '#1c1410', fontSize: 10, fontWeight: 800,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>{selected ? '✓' : ''}</span>
                  <span style={{ minWidth: 0, fontSize: '.78rem', color: '#e2e8f0', lineHeight: 1.3 }}>{displayBettingText(market.name)}</span>
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
                    <strong style={{ fontSize: '.78rem', color: '#5ee6b1' }}>{cap(market.rawProbability ?? market.probability)}%</strong>
                    <small style={{ fontSize: '.7rem', color: '#f5e400', fontFamily: 'JetBrains Mono, monospace' }}>@{Number(market.odd).toFixed(2)}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function BaseballProbBlock({ markets }) {
  if (!markets?.length) {
    return <div style={{ fontSize: '.78rem', color: '#94a3b8' }}>No hay probabilidades publicables sin una cuota Bet365 válida.</div>;
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
      {Object.entries(groupBet365Markets(markets)).map(([category, items]) => (
        <div key={category} style={{
          background: 'rgba(94,230,177,0.05)', border: '1px solid rgba(94,230,177,0.22)',
          borderRadius: 10, padding: '10px 12px', flex: '1 1 240px', minWidth: 0,
        }}>
          <div style={{ fontSize: '.7rem', fontWeight: 800, textTransform: 'uppercase', color: '#5ee6b1', marginBottom: 8 }}>
            {category}
          </div>
          {items.map((market) => (
            <div key={market.id} style={{
              display: 'grid', gridTemplateColumns: '1fr auto auto', alignItems: 'center',
              padding: '6px 0', borderBottom: '1px solid rgba(94,230,177,0.06)', gap: 9,
            }}>
              <span style={{ fontSize: '.72rem', color: '#cbd5e1', lineHeight: 1.3 }}>{displayBettingText(market.name)}</span>
              <strong style={{ fontSize: '.82rem', color: '#fcd34d', fontFamily: 'JetBrains Mono, monospace' }}>{cap(market.rawProbability ?? market.probability)}%</strong>
              <span style={{ fontSize: '.72rem', color: '#f5e400', fontFamily: 'JetBrains Mono, monospace' }}>@{Number(market.odd).toFixed(2)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// =====================================================================
// SUB-COMPONENTES (apuesta del día, combinada tab, empty state)
// =====================================================================
function ApuestaDelDiaBlock({ apuesta, show, onToggle }) {
  return (
    <motion.div
      className="baseball-apuesta"
      initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
    >
      <button className="baseball-apuesta-head" onClick={onToggle}>
        <span className="apuesta-title-block">
          <span className="apuesta-title-icon"><Target size={19} aria-hidden="true" /></span>
          <span><small>Selección inteligente</small><strong>Apuesta del día</strong></span>
        </span>
        <span className="apuesta-head-metrics">
          <span><small>Probabilidad</small><strong>{cap(apuesta.combinedProbability)}%</strong></span>
          {apuesta.combinedOdd && <span><small>Cuota</small><strong>{apuesta.combinedOdd}</strong></span>}
          <ChevronDown className={show ? 'is-open' : ''} size={17} aria-hidden="true" />
        </span>
      </button>
      <AnimatePresence>
        {show && (
          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} style={{ overflow: 'hidden' }}>
            <div className="baseball-apuesta-body">
              <div className="apuesta-summary">
                <Sparkles size={15} aria-hidden="true" />
                {apuesta.selections.length} selecciones ordenadas por oportunidad
              </div>
              {apuesta.selections.map((s, i) => (
                <article className="baseball-apuesta-item" key={i}>
                  <span className="apuesta-index">{String(i + 1).padStart(2, '0')}</span>
                  <span className="apuesta-item-copy">
                    <span className="apuesta-match">
                      <i className={s.priority === 1 ? 'is-live' : ''}>{s.priority === 2 ? 'Próximo' : s.priority === 1 ? 'En vivo' : 'Final'}</i>
                      {s.matchName}
                    </span>
                    <span className="apuesta-mkt">Bet365 · {displayBettingText(s.name || s.market || 'Pick')}</span>
                  </span>
                  <span className="apuesta-item-metrics">
                    <span className="apuesta-prob"><small>Prob.</small>{cap(s.rawProbability ?? s.probability)}%</span>
                    {s.odd && <span className="apuesta-odd"><small>Cuota</small>{s.odd}</span>}
                  </span>
                </article>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function CombinadaTab({ customCombinada, onClear, onRemove }) {
  if (!customCombinada || customCombinada.selections.length === 0) {
    return (
      <div className="empty-state fade-in">
        <div className="empty-icon"><Layers3 size={28} aria-hidden="true" /></div>
        <p>Tu combinada está vacía.</p>
        <small>Expande un partido analizado y selecciona mercados.</small>
      </div>
    );
  }
  return (
    <div className="comb-builder is-baseball fade-in">
      <div className="comb-hero">
        <span className="comb-hero-icon"><Layers3 size={21} aria-hidden="true" /></span>
        <span><small>Constructor inteligente</small><strong>Tu combinada</strong></span>
        <span className="comb-count">{customCombinada.selections.length} selecciones</span>
      </div>

      <div className="comb-list">
        {customCombinada.selections.map((s, i) => (
          <article key={`${s.fixtureId}-${s.marketKey}-${i}`} className="comb-item">
            <span className="comb-item-index">{String(i + 1).padStart(2, '0')}</span>
            <div className="comb-item-content">
              <div className="comb-item-match">{s.matchName}</div>
              <div className="comb-item-name">Bet365 · {displayBettingText(s.name || s.market)}</div>
            </div>
            <div className="comb-item-metrics">
              <span className="comb-item-prob"><small>Prob.</small>{cap(s.rawProbability ?? s.probability)}%</span>
              <span className="comb-item-odd"><small>Cuota</small>{s.odd || '—'}</span>
            </div>
            <button
              className="comb-item-rm"
              onClick={() => onRemove(s.fixtureId, s.marketKey)}
              aria-label={`Quitar ${displayBettingText(s.name || s.market)}`}
            ><X size={15} aria-hidden="true" /></button>
          </article>
        ))}
      </div>

      <div className="comb-summary">
        <div className="comb-sum-row">
          <span>Probabilidad combinada</span>
          <strong>{cap(customCombinada.combinedProbability)}%</strong>
        </div>
        <div className="comb-sum-row">
          <span>Cuota total</span>
          <strong className="comb-odd-total">{customCombinada.combinedOdd || '—'}</strong>
        </div>
      </div>
      <div className="comb-actions">
        <button className="btn-clear" onClick={onClear}><Trash2 size={16} aria-hidden="true" /> Limpiar combinada</button>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>
      <div style={{ fontSize: '3rem', opacity: 0.3 }}>⚾</div>
      <p>No hay partidos para esta fecha.</p>
    </div>
  );
}

// =====================================================================
// STYLES — misma paleta verde del dashboard de fútbol
// =====================================================================
const btn = (color = '#bff4df') => ({
  padding: '6px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(94,230,177,0.18)',
  color, fontSize: '.85rem', fontWeight: 600, cursor: 'pointer',
});
const miniChip = () => ({
  padding: '2px 8px', borderRadius: 6, fontSize: '.72rem', fontWeight: 700,
  background: 'rgba(94,230,177,.10)', border: '1px solid rgba(94,230,177,.28)', color: '#bff4df',
});
