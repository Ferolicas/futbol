'use client';

import { useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import Image from 'next/image';
import useSWR, { mutate as globalMutate } from 'swr';
import { BASEBALL_FLAGS } from '../../../lib/baseball-leagues';
import {
  buildBaseballApuestaDelDia,
  buildCustomBaseballCombinada,
} from '../../../lib/baseball-combinada';
import { fetcher } from '../../../lib/fetcher';

// =====================================================================
// HELPERS
// =====================================================================
const cap = (v) => Math.min(95, Math.max(0, v ?? 0));
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
const statusText = (g) => {
  const s = g?.status?.short;
  if (isLive(s)) {
    const inning = g?.status?.inning ?? '';
    const half = (g?.status?.long || '').toLowerCase();
    const arrow = half.includes('top') ? '↑' : half.includes('bottom') ? '↓' : '';
    return `${arrow}${inning}`.trim() || 'EN VIVO';
  }
  if (isFinished(s)) return 'FIN';
  if (isPostponed(s)) return s === 'POST' ? 'Pospuesto' : s === 'CANC' ? 'Cancelado' : s;
  return 'Próximo';
};

// =====================================================================
// DASHBOARD
// =====================================================================
export default function BaseballDashboard() {
  const router = useRouter();

  const [userTz] = useState(detectTz);
  const [tab, setTab] = useState('partidos');
  const [date, setDate] = useState(() => todayInTz(detectTz()));
  const [sortBy, setSortBy] = useState('time');
  const [statusFilter, setStatusFilter] = useState('all');
  const [leagueFilter, setLeagueFilter] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [analyzing, setAnalyzing] = useState(false);
  const [expandedMatch, setExpandedMatch] = useState(null);
  const [showApuesta, setShowApuesta] = useState(true);
  const [error, setError] = useState('');

  // Custom combinada — manual selections by user
  const [selectedMarkets, setSelectedMarkets] = useState({});

  // ─── SWR: fixtures + quota ─────────────────────────────────────────
  // Bloque G — fuente única, refresh automático 60s, revalidate on focus.
  const fixturesKey = date ? `/api/baseball/fixtures?date=${date}` : null;
  const { data: fxData, mutate: fixturesMutate, isLoading: loadingFixtures } = useSWR(
    fixturesKey,
    fetcher,
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      dedupingInterval: 5000,
      keepPreviousData: true,
    },
  );
  const { data: quotaData } = useSWR('/api/baseball/quota', fetcher, {
    refreshInterval: 300_000,  // 5 min
  });

  const games = fxData?.fixtures || [];
  const quota = quotaData || { used: 0, limit: 100, remaining: 100 };
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
    setSelected(new Set());
    setSelectedMarkets({});
    setExpandedMatch(null);
  };

  const toggleSelect = (id) => {
    setSelected(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const analyzeSelected = async () => {
    const toAnalyze = games.filter(g => selected.has(g.id));
    if (toAnalyze.length === 0) return;
    setAnalyzing(true);
    setError('');
    try {
      const res = await fetch('/api/baseball/analisis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtures: toAnalyze, date }),
      });
      const data = await res.json();

      // El endpoint devuelve un array `analyses` con success/error por
      // fixture. Antes solo se leia `data.error` top-level, ahora tambien
      // mostramos errores individuales para que el usuario sepa POR QUE
      // no se analizo (cuota, fixture incompleto, fallo de DB, etc.).
      if (data.error) {
        setError(data.error);
      } else if (data.failedCount > 0 && data.analyzedCount === 0) {
        const firstErr = (data.analyses || []).find(a => !a.success)?.error || 'desconocido';
        setError(`No se analizó ningún partido (${data.failedCount} fallos). Primero: ${firstErr}`);
      } else if (data.failedCount > 0) {
        const firstErr = (data.analyses || []).find(a => !a.success)?.error || 'desconocido';
        setError(`Analizados ${data.analyzedCount}/${toAnalyze.length}. ${data.failedCount} fallaron: ${firstErr}`);
      }

      setSelected(new Set());
      await fixturesMutate();
      globalMutate('/api/baseball/quota');
    } catch (e) {
      setError('Error al analizar: ' + e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  // Optimistic dismiss + favorite con rollback (mismo patrón que fútbol)
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
  // Fix counter (mismo bug que tuvo fútbol): solo cuenta favoritos PRESENTES hoy
  const favoriteCount = games.filter(g => favorites.includes(g.id) && !hidden.includes(g.id)).length;

  const leagueOptions = useMemo(() => {
    const map = new Map();
    for (const g of games) {
      if (hidden.includes(g.id)) continue;
      if (!g.league?.id) continue;
      map.set(g.league.id, { id: g.league.id, name: g.league.name, country: g.country?.name || g.leagueMeta?.country });
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
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 16px 80px', color: '#e2e8f0' }}>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#f59e0b' }}>⚾ Baseball</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span style={badgePill('#f59e0b')}>API {quota.used}/{quota.limit}</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <button onClick={() => changeDate(-1)} style={btn()}>‹</button>
        <input
          type="date" value={date}
          onChange={(e) => { setDate(e.target.value); setSelected(new Set()); setSelectedMarkets({}); }}
          style={{ ...btn(), minWidth: 140 }}
        />
        <button onClick={() => changeDate(1)} style={btn()}>›</button>
        <button onClick={() => setDate(todayInTz(userTz))} style={btn()}>Hoy</button>

        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ ...btn(), minWidth: 120 }}>
          <option value="time">Hora</option>
          <option value="probability">Análisis</option>
        </select>
        <select value={leagueFilter} onChange={(e) => setLeagueFilter(e.target.value)} style={{ ...btn(), minWidth: 200 }}>
          <option value="">Todas las ligas</option>
          {leagueOptions.map(l => (
            <option key={l.id} value={l.id}>
              {BASEBALL_FLAGS[l.country] || ''} {l.country} — {l.name}
            </option>
          ))}
        </select>
      </div>

      {/* TABS — solo Partidos y Combinada (bloque B: 'Analizados' desaparece, ahora son
          acordeones inline en la lista de Partidos) */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 6 }}>
        {[
          { key: 'partidos', label: 'Partidos', count: visible.length },
          { key: 'combinada', label: 'Combinada', count: totalSel },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={tabBtn(tab === t.key)}>
            {t.label}
            {t.count > 0 && <span style={tabBadge(tab === t.key)}>{t.count}</span>}
          </button>
        ))}
      </div>

      {tab === 'partidos' && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {[
            { key: 'all', label: 'Todos', count: visible.length },
            { key: 'live', label: '🔴 En Vivo', count: liveCount },
            { key: 'upcoming', label: 'Próximos', count: upcomingCount },
            { key: 'finished', label: 'Finalizados' },
            { key: 'favoritos', label: '⭐ Favoritos', count: favoriteCount },
          ].map(c => (
            <button key={c.key} onClick={() => setStatusFilter(c.key)} style={chip(statusFilter === c.key)}>
              {c.label}{c.count > 0 ? ` · ${c.count}` : ''}
            </button>
          ))}
        </div>
      )}

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
        <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>Cargando partidos…</div>
      ) : (
        <>
          {tab === 'partidos' && (
            <>
              {sorted.length === 0 ? (
                <EmptyState />
              ) : (
                groupedByLeague.map(group => (
                  <LeagueGroup
                    key={group.leagueId}
                    group={group}
                    userTz={userTz}
                    selected={selected}
                    favorites={favorites}
                    analyzed={analyzed}
                    expandedMatch={expandedMatch}
                    onExpand={(id) => setExpandedMatch(expandedMatch === id ? null : id)}
                    onSelect={toggleSelect}
                    onFavorite={toggleFavorite}
                    onDismiss={dismissMatch}
                    selectedMarkets={selectedMarkets}
                    onToggleMarket={toggleMarket}
                  />
                ))
              )}
            </>
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

      {tab === 'partidos' && selected.size > 0 && (
        <button
          onClick={analyzeSelected}
          disabled={analyzing}
          style={{
            position: 'fixed', bottom: 80, right: 24, padding: '14px 22px', borderRadius: 999,
            background: 'linear-gradient(135deg, #f59e0b, #d97706)', color: '#06060b',
            fontWeight: 800, border: 'none', cursor: analyzing ? 'wait' : 'pointer',
            boxShadow: '0 8px 24px rgba(245,158,11,0.35)', fontSize: '.95rem', zIndex: 50,
          }}
        >
          {analyzing ? `Analizando ${selected.size}…` : `Analizar ${selected.size} ${selected.size === 1 ? 'partido' : 'partidos'}`}
        </button>
      )}

      {tab !== 'combinada' && totalSel > 0 && (
        <button
          onClick={() => setTab('combinada')}
          style={{
            position: 'fixed', bottom: 24, right: 24, padding: '12px 18px', borderRadius: 999,
            background: '#22d3ee', color: '#06060b', fontWeight: 800, border: 'none', cursor: 'pointer',
            boxShadow: '0 6px 18px rgba(34,211,238,0.3)', zIndex: 50,
          }}
        >
          🎯 Mi combinada · {totalSel}
        </button>
      )}
    </div>
  );
}

// =====================================================================
// LEAGUE GROUP + GAME CARD (con acordeón inline cuando isAnalyzed)
// =====================================================================
function LeagueGroup({ group, userTz, selected, favorites, analyzed, expandedMatch,
                      onExpand, onSelect, onFavorite, onDismiss, selectedMarkets, onToggleMarket }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <h3 style={{
        fontSize: '.92rem', fontWeight: 800, color: '#cbd5e1',
        margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 6,
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <span>{BASEBALL_FLAGS[group.country] || '🌍'}</span>
        <span style={{ color: '#94a3b8' }}>{group.country}</span>
        <span style={{ color: '#f59e0b' }}>·</span>
        <span>{group.leagueName}</span>
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
            isSelected={selected.has(g.id)}
            isFavorite={favorites.includes(g.id)}
            isAnalyzed={analyzed.includes(g.id)}
            isExpanded={expandedMatch === g.id}
            onExpand={() => onExpand(g.id)}
            onSelect={onSelect}
            onFavorite={onFavorite}
            onDismiss={onDismiss}
            selectedMarkets={selectedMarkets[g.id] || {}}
            onToggleMarket={(key, data) => onToggleMarket(g.id, key, data)}
          />
        ))}
      </div>
    </div>
  );
}

function GameCard({ game, userTz, isSelected, isFavorite, isAnalyzed, isExpanded,
                    onExpand, onSelect, onFavorite, onDismiss,
                    selectedMarkets, onToggleMarket }) {
  const home = game.teams?.home;
  const away = game.teams?.away;
  const live = isLive(game.status?.short);
  const finished = isFinished(game.status?.short);
  const liveResult = game.liveResult;
  const homeScore = liveResult?.home_score ?? game.scores?.home?.total;
  const awayScore = liveResult?.away_score ?? game.scores?.away?.total;
  const hasScore = (live || finished) && homeScore != null && awayScore != null;

  const ml = game.analysis?.probabilities?.moneyline;
  const totals = game.analysis?.probabilities?.totals;
  const combinada = game.analysis?.combinada;

  const handleCardClick = (e) => {
    if (e.target.closest('button')) return;
    // Si está analizado: expandir/contraer. Si no: seleccionar para analizar.
    if (isAnalyzed) onExpand();
    else onSelect(game.id);
  };

  return (
    <div
      style={{
        background: isSelected ? 'rgba(245,158,11,0.08)' : 'rgba(255,255,255,0.02)',
        border: isSelected ? '1px solid #f59e0b' : live ? '1px solid rgba(245,158,11,0.4)' : '1px solid rgba(255,255,255,0.06)',
        borderRadius: 12, transition: 'all .15s', overflow: 'hidden',
      }}
    >
      <div onClick={handleCardClick} style={{ padding: 12, cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={(e) => onFavorite(e, game.id)}
            style={{
              width: 26, height: 26, borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)',
              background: isFavorite ? 'rgba(245,158,11,0.18)' : 'transparent',
              color: isFavorite ? '#f59e0b' : '#94a3b8', cursor: 'pointer', fontSize: 14,
            }}
          >★</button>

          <div style={{ flex: 1, minWidth: 0 }}>
            <TeamLine team={home} score={hasScore ? homeScore : null} winner={finished && homeScore > awayScore} />
            <TeamLine team={away} score={hasScore ? awayScore : null} winner={finished && awayScore > homeScore} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, minWidth: 70 }}>
            <span style={{
              fontSize: '.7rem', fontWeight: 800,
              color: live ? '#f59e0b' : finished ? '#94a3b8' : '#22d3ee',
              fontFamily: 'JetBrains Mono, monospace',
            }}>{statusText(game)}</span>
            {!hasScore && (
              <span style={{ fontSize: '.78rem', color: '#22d3ee', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                {fmtTimeInTz(game.date, userTz)}
              </span>
            )}
          </div>
        </div>

        {ml && (
          <div style={{ display: 'flex', gap: 4, fontSize: '.78rem', marginTop: 8, alignItems: 'center' }}>
            <span style={{ color: '#10b981', fontWeight: 700, minWidth: 32 }}>{cap(ml.home).toFixed(0)}%</span>
            <div style={{ flex: 1, height: 5, borderRadius: 3, overflow: 'hidden', display: 'flex', background: 'rgba(255,255,255,0.04)' }}>
              <div style={{ width: `${cap(ml.home)}%`, background: 'linear-gradient(90deg,#10b981,#059669)' }} />
              <div style={{ width: `${cap(ml.away)}%`, background: 'linear-gradient(90deg,#ef4444,#dc2626)' }} />
            </div>
            <span style={{ color: '#ef4444', fontWeight: 700, minWidth: 32, textAlign: 'right' }}>{cap(ml.away).toFixed(0)}%</span>
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Moneyline — favorito + porcentaje. Ej: "Dodgers gana — 67%" */}
          {ml && (() => {
            const homePct = cap(ml.home);
            const awayPct = cap(ml.away);
            const favHome = homePct >= awayPct;
            const favName = favHome ? (home?.name || 'Local') : (away?.name || 'Visitante');
            const favPct = Math.round(favHome ? homePct : awayPct);
            return (
              <span style={miniChip(favPct >= 65 ? '#10b981' : '#22d3ee')}>
                🏆 {favName} {favPct}%
              </span>
            );
          })()}

          {/* Total carreras — Over/Under con el lado más probable */}
          {totals?.bestLine && totals.lines?.[totals.bestLine] && (() => {
            const t = totals.lines[totals.bestLine];
            const overWins = (t.over || 0) >= (t.under || 0);
            const side = overWins ? 'Over' : 'Under';
            const pct = overWins ? t.over : t.under;
            return (
              <span style={miniChip(pct >= 65 ? '#10b981' : '#22d3ee')}>
                {side} {totals.bestLine} carreras — {pct}%
              </span>
            );
          })()}

          {/* Combinada sugerida — N picks + prob combinada */}
          {combinada && combinada.combinedProbability >= 60 && (
            <span style={miniChip('#f59e0b')}>
              🎯 Combinada {combinada.selections?.length || 0} picks · {combinada.combinedProbability}%
              {combinada.combinedOdd ? ` @${combinada.combinedOdd}` : ''}
            </span>
          )}
          {isAnalyzed && (
            <span style={miniChip(isExpanded ? '#f59e0b' : '#22d3ee')}>
              {isExpanded ? 'Ocultar análisis ▲' : 'Ver análisis ▼'}
            </span>
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

      {/* Acordeón inline — bloque B+C */}
      <AnimatePresence initial={false}>
        {isAnalyzed && isExpanded && combinada && (
          <motion.div
            initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }}
            style={{ overflow: 'hidden', borderTop: '1px solid rgba(255,255,255,0.06)' }}
          >
            <div style={{ padding: '12px' }}>
              <AccordionBaseballMarketsBlock
                game={game}
                selectedMarkets={selectedMarkets}
                onToggleMarket={onToggleMarket}
              />

              <AccordionBaseballProbBlock probabilities={game.analysis.probabilities} bestOdds={game.analysis.best_odds}
                                          homeTeam={game.analysis.home_team || home?.name}
                                          awayTeam={game.analysis.away_team || away?.name} />

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                <a
                  href={`/dashboard/baseball/analisis/${game.id}`}
                  style={{
                    padding: '6px 12px', borderRadius: 8, fontSize: '.78rem', fontWeight: 700,
                    background: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.3)',
                    color: '#22d3ee', textDecoration: 'none',
                  }}
                >Ver análisis completo →</a>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TeamLine({ team, score, winner }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0',
      color: winner ? '#f1f5f9' : '#cbd5e1', fontWeight: winner ? 700 : 500,
    }}>
      {team?.logo
        ? <Image src={team.logo} alt={team.name} width={20} height={20} style={{ objectFit: 'contain' }} unoptimized />
        : <span style={{ width: 20, height: 20, background: 'rgba(255,255,255,0.06)', borderRadius: 4 }} />}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '.9rem' }}>{team?.name || '–'}</span>
      {score != null && (
        <span style={{ fontWeight: 800, color: winner ? '#f59e0b' : '#94a3b8', fontSize: '1.05rem', minWidth: 22, textAlign: 'right', fontFamily: 'JetBrains Mono, monospace' }}>{score}</span>
      )}
    </div>
  );
}

// =====================================================================
// ACCORDION: SELECCIONA PARA TU COMBINADA (bloque B)
// Usa combinada.selections como FUENTE ÚNICA (mismo patrón que fútbol).
// =====================================================================
function AccordionBaseballMarketsBlock({ game, selectedMarkets, onToggleMarket }) {
  const sels = game.analysis?.combinada?.selections;
  if (!Array.isArray(sels) || sels.length === 0) return null;

  // Filtro coherente con el acordeón de fútbol: 60-95% (más laxo porque
  // baseball produce menos mercados con prob alta que fútbol).
  const markets = sels
    .filter(s => s.probability >= 60 && s.probability <= 95 && s.odd && s.odd > 1)
    .sort((a, b) => b.probability - a.probability)
    .map(s => ({
      key: s.id,
      label: s.name,
      probability: s.probability,
      odd: s.odd,
      cat: categorizeMarket(s.category, s.scope),
      _line: s._line,
    }));

  if (markets.length === 0) return null;

  // Agrupar por categoría visual
  const byCat = markets.reduce((acc, m) => {
    (acc[m.cat] = acc[m.cat] || []).push(m);
    return acc;
  }, {});

  return (
    <div>
      <div style={{ fontSize: '.78rem', fontWeight: 800, color: '#22d3ee', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
        🎯 Selecciona para tu combinada
      </div>
      {Object.entries(byCat).map(([cat, items]) => (
        <div key={cat} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: '.7rem', color: '#64748b', fontWeight: 800, letterSpacing: 1, marginBottom: 4 }}>{cat}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 6 }}>
            {items.map(m => {
              const sel = !!selectedMarkets[m.key];
              return (
                <button
                  key={m.key}
                  onClick={() => onToggleMarket(m.key, m)}
                  style={{
                    padding: '6px 10px', borderRadius: 8, cursor: 'pointer',
                    background: sel ? 'rgba(34,211,238,0.15)' : 'rgba(255,255,255,0.03)',
                    border: sel ? '1px solid #22d3ee' : '1px solid rgba(255,255,255,0.05)',
                    textAlign: 'left', display: 'flex', alignItems: 'center', gap: 6,
                  }}
                >
                  <span style={{
                    width: 14, height: 14, borderRadius: 3,
                    background: sel ? '#22d3ee' : 'transparent',
                    border: sel ? 'none' : '1px solid #475569',
                    color: '#06060b', fontSize: 10, fontWeight: 800,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>{sel ? '✓' : ''}</span>
                  <span style={{ flex: 1, fontSize: '.78rem', color: '#cbd5e1' }}>{m.label}</span>
                  <span style={{ fontWeight: 800, fontSize: '.78rem', color: m.probability >= 75 ? '#10b981' : m.probability >= 60 ? '#f59e0b' : '#94a3b8' }}>
                    {m.probability}%
                  </span>
                  <span style={{ fontSize: '.7rem', color: '#22d3ee', fontFamily: 'JetBrains Mono, monospace' }}>@{m.odd}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function categorizeMarket(category, scope) {
  if (!category) return 'Otros';
  if (category === 'moneyline') return 'Moneyline';
  if (category.startsWith('total-')) return 'Total Carreras';
  if (category.startsWith('runline')) return 'Run Line';
  if (category.startsWith('f5')) return 'F5 (primeras 5 entradas)';
  if (category === 'btts') return 'Ambos anotan';
  if (category.startsWith('home-total')) return 'Total Local';
  if (category.startsWith('away-total')) return 'Total Visitante';
  if (category.startsWith('pl-k-')) return 'Ponches por pitcher';
  if (category.startsWith('pl-h-')) return 'Hits por bateador';
  if (category.startsWith('pl-tb-')) return 'Bases totales';
  if (category.startsWith('pl-rbi-')) return 'RBIs';
  if (category.startsWith('pl-hr-')) return 'Home Runs';
  return scope === 'player' ? 'Jugador' : 'Otros';
}

// =====================================================================
// % PROBABILIDADES CALCULADAS — bloque C (acordeón compacto)
// =====================================================================
function AccordionBaseballProbBlock({ probabilities: p, bestOdds, homeTeam, awayTeam }) {
  if (!p) return null;
  const hasOdd = (v) => isFinite(parseFloat(v)) && parseFloat(v) > 1;

  const adaptiveCat = (probObj, oddObj, makeLabel) => {
    if (!probObj || !oddObj) return [];
    return Object.entries(probObj).map(([line, vals]) => {
      if (line.startsWith('_')) return null;
      const overOdd = oddObj[line]?.over?.odd ?? oddObj?.[line]?.over;
      const underOdd = oddObj[line]?.under?.odd ?? oddObj?.[line]?.under;
      return [
        hasOdd(overOdd) && vals.over != null && { label: makeLabel('Más de', line), value: vals.over },
        hasOdd(underOdd) && vals.under != null && { label: makeLabel('Menos de', line), value: vals.under },
      ].filter(Boolean);
    }).flat().filter(Boolean);
  };

  const cats = [
    { title: 'Moneyline (Ganador)', items: [
      hasOdd(bestOdds?.moneyline?.home) && p.moneyline && { label: homeTeam, value: p.moneyline.home },
      hasOdd(bestOdds?.moneyline?.away) && p.moneyline && { label: awayTeam, value: p.moneyline.away },
    ].filter(Boolean) },

    p.totals?.lines && {
      title: 'Total de carreras',
      subtitle: p.expected?.totalRuns != null ? `Esperado: ${p.expected.totalRuns}` : null,
      items: adaptiveCat(p.totals.lines, bestOdds?.totals, (verb, line) => `${verb} ${line}`),
    },

    p.runLine && {
      title: 'Run Line ±1.5',
      items: [
        p.runLine.home_minus_1_5 != null && { label: `${homeTeam} -1.5`, value: p.runLine.home_minus_1_5 },
        p.runLine.away_plus_1_5  != null && { label: `${awayTeam} +1.5`, value: p.runLine.away_plus_1_5 },
        p.runLine.away_minus_1_5 != null && { label: `${awayTeam} -1.5`, value: p.runLine.away_minus_1_5 },
        p.runLine.home_plus_1_5  != null && { label: `${homeTeam} +1.5`, value: p.runLine.home_plus_1_5 },
      ].filter(Boolean),
    },

    p.f5?.moneyline && {
      title: 'F5 — Ganador',
      items: [
        { label: `${homeTeam} F5`, value: p.f5.moneyline.home },
        { label: `${awayTeam} F5`, value: p.f5.moneyline.away },
        p.f5.moneyline.tie != null && { label: 'Empate F5', value: p.f5.moneyline.tie },
      ].filter(Boolean),
    },

    p.f5?.totals && {
      title: 'F5 — Total carreras',
      items: Object.entries(p.f5.totals).map(([line, vals]) => ([
        vals.over != null && { label: `F5 Más de ${line}`, value: vals.over },
        vals.under != null && { label: `F5 Menos de ${line}`, value: vals.under },
      ].filter(Boolean))).flat().filter(Boolean),
    },

    p.teamTotals?.home && {
      title: `Total — ${homeTeam}`,
      items: Object.entries(p.teamTotals.home).map(([line, vals]) => ([
        vals.over != null && { label: `Más de ${line}`, value: vals.over },
        vals.under != null && { label: `Menos de ${line}`, value: vals.under },
      ].filter(Boolean))).flat().filter(Boolean),
    },

    p.teamTotals?.away && {
      title: `Total — ${awayTeam}`,
      items: Object.entries(p.teamTotals.away).map(([line, vals]) => ([
        vals.over != null && { label: `Más de ${line}`, value: vals.over },
        vals.under != null && { label: `Menos de ${line}`, value: vals.under },
      ].filter(Boolean))).flat().filter(Boolean),
    },

    p.btts && { title: 'Ambos anotan 1+ carrera', items: [
      { label: 'Sí', value: p.btts.yes },
      { label: 'No', value: p.btts.no },
    ] },

    // Bloque F — player markets (cuando lleguen)
    p.players?.strikeouts?.length > 0 && {
      title: 'Ponches por pitcher',
      items: p.players.strikeouts.flatMap(pl =>
        Object.entries(pl.lineProbs || {}).map(([line, prob]) => ({
          label: `${pl.name} — Más de ${line} K`,
          value: prob,
        })),
      ),
    },
    p.players?.hits?.length > 0 && {
      title: 'Hits por bateador',
      items: p.players.hits.flatMap(pl =>
        Object.entries(pl.lineProbs || {}).map(([line, prob]) => ({
          label: `${pl.name} — Más de ${line} hits`,
          value: prob,
        })),
      ),
    },
    p.players?.totalBases?.length > 0 && {
      title: 'Bases totales',
      items: p.players.totalBases.flatMap(pl =>
        Object.entries(pl.lineProbs || {}).map(([line, prob]) => ({
          label: `${pl.name} — Bases > ${line}`,
          value: prob,
        })),
      ),
    },
    p.players?.rbis?.length > 0 && {
      title: 'RBIs',
      items: p.players.rbis.flatMap(pl =>
        Object.entries(pl.lineProbs || {}).map(([line, prob]) => ({
          label: `${pl.name} — Más de ${line} RBI`,
          value: prob,
        })),
      ),
    },
    p.players?.homeRuns?.length > 0 && {
      title: 'Home Runs',
      items: p.players.homeRuns.flatMap(pl => {
        const hist = pl.history || [];
        const hits = hist.filter(v => (v || 0) >= 1).length;
        const prob = hist.length > 0 ? Math.round((hits / hist.length) * 100) : 0;
        return [{ label: `${pl.name} — HR (anytime)`, value: prob }];
      }),
    },
  ].filter(Boolean).filter(c => c.items && c.items.length > 0);

  if (cats.length === 0) return null;

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.75rem', fontWeight: 700, color: '#2dd4bf', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 10 }}>
        <span>📊</span> % Probabilidades calculadas
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {cats.map((cat, ci) => (
          <div key={ci} style={{ background: 'rgba(45,212,191,0.04)', border: '1px solid rgba(45,212,191,0.2)', borderRadius: 10, padding: '10px 12px', flex: '1 1 220px', minWidth: 0 }}>
            <div style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: '#94a3b8', marginBottom: cat.subtitle ? 2 : 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cat.title}</div>
            {cat.subtitle && <div style={{ fontSize: '.65rem', color: '#64748b', marginBottom: 8 }}>{cat.subtitle}</div>}
            {cat.items.map((it, i) => {
              const v = Math.round(it.value ?? 0);
              const color = v >= 80 ? '#4ade80' : v >= 65 ? '#fbbf24' : v >= 50 ? '#f97316' : '#94a3b8';
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', gap: 8 }}>
                  <span style={{ fontSize: '.72rem', color: '#cbd5e1', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                  <span style={{ fontSize: '.85rem', fontWeight: 700, color, fontFamily: 'JetBrains Mono, monospace', fontVariantNumeric: 'tabular-nums' }}>{v}%</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// =====================================================================
// SUB-COMPONENTES (apuesta del día, combinada tab, empty state)
// =====================================================================
function ApuestaDelDiaBlock({ apuesta, show, onToggle }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
      style={{
        background: 'linear-gradient(135deg, rgba(245,158,11,0.12), rgba(239,68,68,0.06))',
        border: '1px solid rgba(245,158,11,0.4)', borderRadius: 14, marginBottom: 16, overflow: 'hidden',
      }}
    >
      <button
        onClick={onToggle}
        style={{
          width: '100%', padding: '12px 14px', background: 'transparent', border: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', color: '#f59e0b',
        }}
      >
        <span style={{ fontWeight: 800, fontSize: '.95rem' }}>🎯 Apuesta del Día</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: '1.3rem', fontWeight: 800 }}>{apuesta.combinedProbability}%</span>
          {apuesta.combinedOdd && (
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '1rem', color: '#22d3ee' }}>
              @{apuesta.combinedOdd}
            </span>
          )}
          <span style={{ transform: show ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>▼</span>
        </span>
      </button>
      <AnimatePresence>
        {show && (
          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} style={{ overflow: 'hidden' }}>
            <div style={{ padding: '0 14px 14px' }}>
              {apuesta.selections.map((s, i) => (
                <div key={i} style={{
                  display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 8, alignItems: 'center',
                  padding: '8px 10px', borderRadius: 8, marginBottom: 4,
                  background: 'rgba(255,255,255,0.03)',
                }}>
                  <div style={{ fontSize: '.78rem', color: '#cbd5e1' }}>
                    <span style={{
                      fontSize: '.65rem', fontWeight: 800, padding: '1px 6px', borderRadius: 4, marginRight: 6,
                      background: s.priority === 2 ? 'rgba(34,211,238,0.15)' : s.priority === 1 ? 'rgba(239,68,68,0.15)' : 'rgba(148,163,184,0.15)',
                      color: s.priority === 2 ? '#22d3ee' : s.priority === 1 ? '#ef4444' : '#94a3b8',
                    }}>
                      {s.priority === 2 ? '●' : s.priority === 1 ? 'LIVE' : 'FIN'}
                    </span>
                    {s.matchName}
                  </div>
                  <span style={{ fontSize: '.78rem', color: '#94a3b8' }}>{s.name}</span>
                  <span style={{ fontWeight: 800, color: s.probability >= 80 ? '#10b981' : '#f59e0b' }}>{s.probability}%</span>
                  {s.odd && <span style={{ fontFamily: 'JetBrains Mono, monospace', color: '#22d3ee' }}>@{s.odd}</span>}
                </div>
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
      <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>
        <div style={{ fontSize: '2.5rem', opacity: 0.3 }}>🎯</div>
        <p>Tu combinada está vacía.</p>
        <p style={{ fontSize: '.85rem', opacity: 0.7 }}>Expande un partido analizado y selecciona mercados.</p>
      </div>
    );
  }
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 14px', background: 'rgba(34,211,238,0.08)',
        border: '1px solid rgba(34,211,238,0.3)', borderRadius: 12, marginBottom: 12,
      }}>
        <div>
          <div style={{ fontSize: '.75rem', color: '#94a3b8', fontWeight: 700 }}>Probabilidad combinada</div>
          <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#22d3ee' }}>
            {customCombinada.combinedProbability}%
            {customCombinada.combinedOdd && (
              <span style={{ marginLeft: 12, color: '#10b981', fontFamily: 'JetBrains Mono, monospace' }}>
                @{customCombinada.combinedOdd}
              </span>
            )}
          </div>
        </div>
        <button onClick={onClear} style={{ ...btn('#ef4444'), padding: '8px 14px' }}>Limpiar todo</button>
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        {customCombinada.selections.map((s, i) => (
          <div key={`${s.fixtureId}-${s.marketKey}-${i}`} style={{
            display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 8, alignItems: 'center',
            padding: '10px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.03)',
          }}>
            <div>
              <div style={{ fontSize: '.78rem', color: '#94a3b8', marginBottom: 2 }}>{s.matchName}</div>
              <div style={{ fontSize: '.85rem', color: '#cbd5e1', fontWeight: 600 }}>{s.name || s.market}</div>
            </div>
            <span style={{ fontWeight: 800, color: s.probability >= 75 ? '#10b981' : '#f59e0b' }}>{s.probability}%</span>
            {s.odd && <span style={{ fontFamily: 'JetBrains Mono, monospace', color: '#22d3ee' }}>@{s.odd}</span>}
            <button
              onClick={() => onRemove(s.fixtureId, s.marketKey)}
              style={{
                width: 24, height: 24, borderRadius: 6, background: 'transparent',
                color: '#94a3b8', border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer',
              }}
            >✕</button>
          </div>
        ))}
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
// STYLES
// =====================================================================
const btn = (color = '#f59e0b') => ({
  padding: '6px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  color, fontSize: '.85rem', fontWeight: 600, cursor: 'pointer',
});
const tabBtn = (active) => ({
  padding: '8px 16px', borderRadius: 8, background: active ? 'rgba(245,158,11,0.15)' : 'transparent',
  border: active ? '1px solid rgba(245,158,11,0.4)' : '1px solid transparent',
  color: active ? '#f59e0b' : '#94a3b8', fontWeight: active ? 700 : 600, cursor: 'pointer',
  fontSize: '.9rem', display: 'flex', alignItems: 'center', gap: 8,
});
const tabBadge = (active) => ({
  padding: '1px 7px', borderRadius: 999, fontSize: '.7rem', fontWeight: 800,
  background: active ? '#f59e0b' : 'rgba(148,163,184,0.2)', color: active ? '#06060b' : '#94a3b8',
});
const chip = (active) => ({
  padding: '5px 11px', borderRadius: 999, background: active ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.03)',
  border: active ? '1px solid #f59e0b' : '1px solid rgba(255,255,255,0.06)',
  color: active ? '#f59e0b' : '#cbd5e1', fontWeight: 600, fontSize: '.78rem', cursor: 'pointer',
});
const badgePill = (color) => ({
  padding: '4px 10px', borderRadius: 999, background: `${color}1a`,
  border: `1px solid ${color}55`, color, fontSize: '.72rem', fontWeight: 700,
});
const miniChip = (color) => ({
  padding: '2px 8px', borderRadius: 6, fontSize: '.72rem', fontWeight: 700,
  background: `${color}1a`, border: `1px solid ${color}55`, color,
});
