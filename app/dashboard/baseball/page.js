'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../../components/providers';
import { motion, AnimatePresence } from 'framer-motion';
import Image from 'next/image';
import { BASEBALL_FLAGS } from '../../../lib/baseball-leagues';
import { buildBaseballApuestaDelDia } from '../../../lib/baseball-combinada';

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

// Module-level cache (survives SPA navigation)
let _bbCache = null;
let _splashDone = false;

// =====================================================================
// DASHBOARD
// =====================================================================
export default function BaseballDashboard() {
  const router = useRouter();
  const { user } = useAuth();

  const [splash, setSplash] = useState(!_splashDone);
  const [splashFade, setSplashFade] = useState(false);
  const [userTz, setUserTz] = useState('UTC');
  const [tab, setTab] = useState('partidos');
  const [date, setDate] = useState(todayInTz(detectTz()));
  const [games, setGames] = useState(_bbCache?.games || []);
  const [loading, setLoading] = useState(!_bbCache);
  const [error, setError] = useState('');
  const [quota, setQuota] = useState(_bbCache?.quota || { used: 0, limit: 100, remaining: 100 });
  const [hidden, setHidden] = useState(_bbCache?.hidden || []);
  const [favorites, setFavorites] = useState(_bbCache?.favorites || []);
  const [analyzed, setAnalyzed] = useState(_bbCache?.analyzed || []);
  const [sortBy, setSortBy] = useState('time');
  const [statusFilter, setStatusFilter] = useState('all');
  const [leagueFilter, setLeagueFilter] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [analyzing, setAnalyzing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedMatch, setExpandedMatch] = useState(null);
  const [showApuesta, setShowApuesta] = useState(true);

  // Custom combinada — manual selections by user, key fixtureId → array of selections
  const [selectedMarkets, setSelectedMarkets] = useState({});
  const [savedCombinadas, setSavedCombinadas] = useState([]);

  useEffect(() => { setUserTz(detectTz()); }, []);

  // Splash effect (1st visit only)
  const loadingRef = useRef(loading);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  useEffect(() => {
    if (_splashDone) { setSplash(false); return; }
    const minTime = new Promise(r => setTimeout(r, 700));
    const dataReady = new Promise(r => {
      const check = () => !loadingRef.current ? r() : setTimeout(check, 50);
      check();
    });
    Promise.all([minTime, dataReady]).then(() => {
      _splashDone = true;
      setSplashFade(true);
      setTimeout(() => setSplash(false), 350);
    });
  }, []);

  // ────── DATA LOADING ──────
  const loadGames = useCallback(async (d, { silent } = {}) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/baseball/fixtures?date=${d}`);
      const data = await res.json();
      if (!res.ok && !data.fixtures) throw new Error(data.error || 'Failed');
      const fx = data.fixtures || [];
      setGames(fx);
      const newHidden = fx.filter(g => g.isHidden).map(g => g.id);
      const newFav = fx.filter(g => g.isFavorite).map(g => g.id);
      const newAnalyzed = fx.filter(g => g.isAnalyzed).map(g => g.id);
      setHidden(newHidden);
      setFavorites(newFav);
      setAnalyzed(newAnalyzed);

      _bbCache = {
        games: fx,
        hidden: newHidden,
        favorites: newFav,
        analyzed: newAnalyzed,
        quota: data.quota || quota,
      };
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadQuota = useCallback(async () => {
    try {
      const res = await fetch('/api/baseball/quota');
      const q = await res.json();
      setQuota(q);
    } catch {}
  }, []);

  useEffect(() => { loadGames(date); loadQuota(); }, [date, loadGames, loadQuota]);

  // Live polling: every 60s if there are live games
  useEffect(() => {
    const hasLive = games.some(g => isLive(g.status?.short));
    if (!hasLive) return;
    const t = setInterval(() => loadGames(date, { silent: true }), 60000);
    return () => clearInterval(t);
  }, [games, date, loadGames]);

  // ────── ACTIONS ──────
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
    try {
      const res = await fetch('/api/baseball/analisis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtures: toAnalyze, date }),
      });
      const data = await res.json();
      if (data.quota) setQuota(data.quota);
      if (data.error) setError(data.error);
      const newIds = (data.analyses || []).filter(a => a.success).map(a => a.fixtureId);
      setAnalyzed(prev => [...new Set([...prev, ...newIds])]);
      setSelected(new Set());
      await loadGames(date, { silent: true });
      if (newIds.length > 0) setTab('analizados');
    } catch (e) {
      setError('Error al analizar: ' + e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleManualRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadGames(date, { silent: true }), loadQuota()]);
    setRefreshing(false);
  };

  const dismissMatch = async (e, fixtureId) => {
    e.stopPropagation();
    setHidden(prev => prev.includes(fixtureId) ? prev : [...prev, fixtureId]);
    setAnalyzed(prev => prev.filter(id => id !== fixtureId));
    setSelectedMarkets(prev => { const n = { ...prev }; delete n[fixtureId]; return n; });
    try {
      await fetch('/api/baseball/hidden', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId, date, action: 'hide' }),
      });
    } catch {}
  };

  const toggleFavorite = async (e, fixtureId) => {
    e.stopPropagation();
    const isFav = favorites.includes(fixtureId);
    setFavorites(prev => isFav ? prev.filter(id => id !== fixtureId) : [...prev, fixtureId]);
    try {
      await fetch('/api/baseball/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId, action: isFav ? 'remove' : 'add' }),
      });
    } catch {}
  };

  // ────── MARKET SELECTION (custom combinada) ──────
  const toggleMarket = (fixtureId, marketKey, marketData) => {
    setSelectedMarkets(prev => {
      const fixMarkets = { ...(prev[fixtureId] || {}) };
      if (fixMarkets[marketKey]) {
        delete fixMarkets[marketKey];
      } else {
        fixMarkets[marketKey] = marketData;
      }
      const next = { ...prev };
      if (Object.keys(fixMarkets).length === 0) delete next[fixtureId];
      else next[fixtureId] = fixMarkets;
      return next;
    });
  };

  const totalSel = Object.values(selectedMarkets).reduce((s, m) => s + Object.keys(m).length, 0);

  // Custom combinada calc
  const customCombinada = useMemo(() => {
    const selections = [];
    for (const [fid, markets] of Object.entries(selectedMarkets)) {
      const game = games.find(g => g.id === Number(fid));
      if (!game) continue;
      const matchName = `${game.teams?.home?.name} vs ${game.teams?.away?.name}`;
      for (const [key, m] of Object.entries(markets)) {
        selections.push({ matchName, ...m, fixtureId: Number(fid), marketKey: key });
      }
    }
    if (selections.length === 0) return null;
    const prob = selections.reduce((a, s) => a * (s.probability / 100), 1);
    const allOdds = selections.every(s => s.odd && s.odd > 1);
    const odd = allOdds ? selections.reduce((a, s) => a * s.odd, 1) : null;
    return {
      selections,
      combinedProbability: Math.round(prob * 100),
      combinedOdd: odd ? +odd.toFixed(2) : null,
      hasRealOdds: allOdds,
    };
  }, [selectedMarkets, games]);

  // ────── DERIVED ──────
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
    [games, analyzed, hidden]
  );

  const apuestaDelDia = useMemo(() => buildBaseballApuestaDelDia(analyzedGames), [analyzedGames]);

  const liveCount = games.filter(g => !hidden.includes(g.id) && isLive(g.status?.short)).length;
  const upcomingCount = games.filter(g => !hidden.includes(g.id) && g.status?.short === 'NS').length;
  const favoriteCount = favorites.length;

  const leagueOptions = useMemo(() => {
    const map = new Map();
    for (const g of games) {
      if (hidden.includes(g.id)) continue;
      if (!g.league?.id) continue;
      map.set(g.league.id, { id: g.league.id, name: g.league.name, country: g.country?.name || g.leagueMeta?.country });
    }
    return Array.from(map.values()).sort((a, b) => (a.country || '').localeCompare(b.country || ''));
  }, [games, hidden]);

  // Group sorted games by league for partidos tab
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

  // ────── SPLASH ──────
  if (splash) {
    return (
      <div style={{
        position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#06060b', zIndex: 9999, opacity: splashFade ? 0 : 1, transition: 'opacity .35s',
      }}>
        <div style={{ textAlign: 'center', color: '#f59e0b' }}>
          <div style={{ fontSize: '4rem', animation: 'pulse 1.4s ease-in-out infinite' }}>⚾</div>
          <div style={{ fontSize: '1rem', marginTop: 14, fontWeight: 700, letterSpacing: 1 }}>CFANALISIS · BASEBALL</div>
        </div>
      </div>
    );
  }

  // ────── RENDER ──────
  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 16px 80px', color: '#e2e8f0' }}>

      {/* TOP BAR */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#f59e0b' }}>⚾ Baseball</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span style={badgePill('#f59e0b')}>API {quota.used}/{quota.limit}</span>
          <button onClick={handleManualRefresh} disabled={refreshing} style={btn('#22d3ee')}>{refreshing ? '...' : '↻ Refresh'}</button>
        </div>
      </div>

      {/* DATE NAV */}
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

      {/* TABS */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 6 }}>
        {[
          { key: 'partidos', label: 'Partidos', count: visible.length },
          { key: 'analizados', label: 'Analizados', count: analyzedGames.length },
          { key: 'combinada', label: 'Combinada', count: totalSel },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={tabBtn(tab === t.key)}>
            {t.label}
            {t.count > 0 && <span style={tabBadge(tab === t.key)}>{t.count}</span>}
          </button>
        ))}
      </div>

      {/* STATUS CHIPS (only on Partidos tab) */}
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

      {/* APUESTA DEL DÍA */}
      {apuestaDelDia && tab === 'partidos' && (
        <motion.div
          initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
          style={{
            background: 'linear-gradient(135deg, rgba(245,158,11,0.12), rgba(239,68,68,0.06))',
            border: '1px solid rgba(245,158,11,0.4)', borderRadius: 14, marginBottom: 16, overflow: 'hidden',
          }}
        >
          <button
            onClick={() => setShowApuesta(!showApuesta)}
            style={{
              width: '100%', padding: '12px 14px', background: 'transparent', border: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', color: '#f59e0b',
            }}
          >
            <span style={{ fontWeight: 800, fontSize: '.95rem' }}>🎯 Apuesta del Día</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: '1.3rem', fontWeight: 800 }}>{apuestaDelDia.combinedProbability}%</span>
              {apuestaDelDia.combinedOdd && (
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '1rem', color: '#22d3ee' }}>
                  @{apuestaDelDia.combinedOdd}
                </span>
              )}
              <span style={{ transform: showApuesta ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>▼</span>
            </span>
          </button>
          <AnimatePresence>
            {showApuesta && (
              <motion.div
                initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }}
                style={{ overflow: 'hidden' }}
              >
                <div style={{ padding: '0 14px 14px' }}>
                  {apuestaDelDia.selections.map((s, i) => (
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
      )}

      {/* ERROR */}
      {error && (
        <div style={{
          padding: 12, borderRadius: 10, marginBottom: 14,
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5',
        }}>{error}</div>
      )}

      {/* BODY */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>Cargando partidos...</div>
      ) : (
        <>
          {/* TAB: PARTIDOS */}
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
                    onSelect={toggleSelect}
                    onFavorite={toggleFavorite}
                    onDismiss={dismissMatch}
                  />
                ))
              )}
            </>
          )}

          {/* TAB: ANALIZADOS */}
          {tab === 'analizados' && (
            <AnalyzedTab
              games={analyzedGames}
              expandedMatch={expandedMatch}
              onExpand={(id) => setExpandedMatch(expandedMatch === id ? null : id)}
              selectedMarkets={selectedMarkets}
              onToggleMarket={toggleMarket}
              onDismiss={dismissMatch}
              userTz={userTz}
            />
          )}

          {/* TAB: COMBINADA */}
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

      {/* FLOATING ANALYZE BUTTON */}
      {tab === 'partidos' && selected.size > 0 && (
        <button
          onClick={analyzeSelected}
          disabled={analyzing}
          style={{
            position: 'fixed', bottom: 80, right: 24, padding: '14px 22px', borderRadius: 999,
            background: 'linear-gradient(135deg, #f59e0b, #d97706)', color: '#06060b',
            fontWeight: 800, border: 'none', cursor: analyzing ? 'wait' : 'pointer',
            boxShadow: '0 8px 24px rgba(245,158,11,0.35)', fontSize: '.95rem',
            zIndex: 50,
          }}
        >
          {analyzing ? `Analizando ${selected.size}...` : `Analizar ${selected.size} ${selected.size === 1 ? 'partido' : 'partidos'}`}
        </button>
      )}

      {/* FLOATING COMBINADA BUTTON */}
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
// SUB COMPONENTS
// =====================================================================

function LeagueGroup({ group, userTz, selected, favorites, analyzed, onSelect, onFavorite, onDismiss }) {
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
            onSelect={onSelect}
            onFavorite={onFavorite}
            onDismiss={onDismiss}
          />
        ))}
      </div>
    </div>
  );
}

function GameCard({ game, userTz, isSelected, isFavorite, isAnalyzed, onSelect, onFavorite, onDismiss }) {
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

  return (
    <div
      onClick={() => onSelect(game.id)}
      style={{
        background: isSelected ? 'rgba(245,158,11,0.08)' : 'rgba(255,255,255,0.02)',
        border: isSelected ? '1px solid #f59e0b' : live ? '1px solid rgba(245,158,11,0.4)' : '1px solid rgba(255,255,255,0.06)',
        borderRadius: 12, padding: 12, cursor: 'pointer', transition: 'all .15s',
      }}
    >
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

      {/* Probability bar */}
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
        {totals?.bestLine && totals.lines?.[totals.bestLine] && (
          <span style={miniChip('#22d3ee')}>
            O/U {totals.bestLine}: {Math.max(totals.lines[totals.bestLine].over, totals.lines[totals.bestLine].under)}%
          </span>
        )}
        {combinada && combinada.combinedProbability >= 60 && (
          <span style={miniChip('#10b981')}>
            🎯 {combinada.combinedProbability}%{combinada.combinedOdd ? ` @${combinada.combinedOdd}` : ''}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {isAnalyzed && (
          <a
            href={`/dashboard/baseball/analisis/${game.id}`}
            onClick={(e) => e.stopPropagation()}
            style={{
              padding: '4px 10px', borderRadius: 6, fontSize: '.72rem', fontWeight: 700,
              background: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.3)',
              color: '#22d3ee', textDecoration: 'none',
            }}
          >Ver →</a>
        )}
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

function AnalyzedTab({ games, expandedMatch, onExpand, selectedMarkets, onToggleMarket, onDismiss, userTz }) {
  if (games.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>
        <div style={{ fontSize: '2.5rem', opacity: 0.3 }}>📊</div>
        <p>No hay partidos analizados aún.</p>
        <p style={{ fontSize: '.85rem', opacity: 0.7 }}>Ve a la pestaña "Partidos", selecciona uno o más, y pulsa "Analizar".</p>
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {games.map(g => (
        <AnalyzedCard
          key={g.id}
          game={g}
          isExpanded={expandedMatch === g.id}
          onExpand={() => onExpand(g.id)}
          selectedMarkets={selectedMarkets[g.id] || {}}
          onToggleMarket={(key, data) => onToggleMarket(g.id, key, data)}
          onDismiss={onDismiss}
          userTz={userTz}
        />
      ))}
    </div>
  );
}

function AnalyzedCard({ game, isExpanded, onExpand, selectedMarkets, onToggleMarket, onDismiss, userTz }) {
  const a = game.analysis;
  const probs = a?.probabilities;
  const bestOdds = a?.best_odds;
  const ml = probs?.moneyline;

  // Build market list with metadata for selection
  const markets = useMemo(() => {
    if (!probs) return [];
    const list = [];
    if (ml) {
      list.push({
        key: 'ml_home', cat: 'Ganador', label: `${a.home_team} gana`, name: 'Moneyline Home',
        probability: cap(ml.home), odd: bestOdds?.moneyline?.home || null,
      });
      list.push({
        key: 'ml_away', cat: 'Ganador', label: `${a.away_team} gana`, name: 'Moneyline Away',
        probability: cap(ml.away), odd: bestOdds?.moneyline?.away || null,
      });
    }
    if (probs.totals?.lines) {
      for (const [line, val] of Object.entries(probs.totals.lines)) {
        list.push({
          key: `total_o_${line}`, cat: 'Carreras', label: `Over ${line}`, name: `Over ${line} carreras`,
          probability: val.over, odd: bestOdds?.totals?.[line]?.over?.odd || null,
        });
        list.push({
          key: `total_u_${line}`, cat: 'Carreras', label: `Under ${line}`, name: `Under ${line} carreras`,
          probability: val.under, odd: bestOdds?.totals?.[line]?.under?.odd || null,
        });
      }
    }
    if (probs.runLine) {
      list.push({ key: 'rl_home_-15', cat: 'Run Line', label: `${a.home_team} -1.5`, name: 'Run Line', probability: probs.runLine.home_minus_1_5, odd: null });
      list.push({ key: 'rl_away_+15', cat: 'Run Line', label: `${a.away_team} +1.5`, name: 'Run Line', probability: probs.runLine.away_plus_1_5, odd: null });
      list.push({ key: 'rl_away_-15', cat: 'Run Line', label: `${a.away_team} -1.5`, name: 'Run Line', probability: probs.runLine.away_minus_1_5, odd: null });
      list.push({ key: 'rl_home_+15', cat: 'Run Line', label: `${a.home_team} +1.5`, name: 'Run Line', probability: probs.runLine.home_plus_1_5, odd: null });
    }
    if (probs.f5?.moneyline) {
      list.push({ key: 'f5_ml_home', cat: 'F5', label: `${a.home_team} F5`, name: 'F5 Moneyline', probability: probs.f5.moneyline.home, odd: null });
      list.push({ key: 'f5_ml_away', cat: 'F5', label: `${a.away_team} F5`, name: 'F5 Moneyline', probability: probs.f5.moneyline.away, odd: null });
    }
    if (probs.f5?.totals) {
      for (const [line, val] of Object.entries(probs.f5.totals)) {
        list.push({ key: `f5_o_${line}`, cat: 'F5 Carreras', label: `F5 Over ${line}`, name: 'F5 Total', probability: val.over, odd: null });
        list.push({ key: `f5_u_${line}`, cat: 'F5 Carreras', label: `F5 Under ${line}`, name: 'F5 Total', probability: val.under, odd: null });
      }
    }
    if (probs.btts) {
      list.push({ key: 'btts_yes', cat: 'BTTS', label: 'Ambos anotan 1+', name: 'Both Teams Score', probability: probs.btts.yes, odd: null });
      list.push({ key: 'btts_no', cat: 'BTTS', label: 'Algún equipo en blanco', name: 'Both Teams Score', probability: probs.btts.no, odd: null });
    }
    if (probs.teamTotals?.home) {
      for (const [line, val] of Object.entries(probs.teamTotals.home)) {
        list.push({ key: `tt_h_o_${line}`, cat: 'Team Total', label: `${a.home_team} O ${line}`, name: 'Team Total Home', probability: val.over, odd: null });
      }
    }
    if (probs.teamTotals?.away) {
      for (const [line, val] of Object.entries(probs.teamTotals.away)) {
        list.push({ key: `tt_a_o_${line}`, cat: 'Team Total', label: `${a.away_team} O ${line}`, name: 'Team Total Away', probability: val.over, odd: null });
      }
    }
    return list;
  }, [probs, bestOdds, a]);

  return (
    <div style={{
      background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 12, overflow: 'hidden',
    }}>
      <div onClick={onExpand} style={{ padding: 12, cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '.7rem', color: '#64748b', fontWeight: 700, marginBottom: 2 }}>
              {BASEBALL_FLAGS[a.country] || ''} {a.country} · {a.league_name}
            </div>
            <div style={{ fontWeight: 700, fontSize: '.95rem' }}>{a.home_team} vs {a.away_team}</div>
          </div>
          {a.combinada?.combinedProbability >= 60 && (
            <span style={miniChip('#10b981')}>🎯 {a.combinada.combinedProbability}%{a.combinada.combinedOdd ? ` @${a.combinada.combinedOdd}` : ''}</span>
          )}
          <span style={{ color: '#94a3b8', fontSize: '.85rem' }}>{isExpanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {isExpanded && (
        <div style={{ padding: '0 12px 12px', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
          <div style={{ fontSize: '.8rem', color: '#94a3b8', margin: '12px 0 8px', fontWeight: 700 }}>
            Selecciona mercados para tu combinada:
          </div>
          {/* Group markets by category */}
          {Object.entries(markets.reduce((acc, m) => {
            (acc[m.cat] = acc[m.cat] || []).push(m); return acc;
          }, {})).map(([cat, mks]) => (
            <div key={cat} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: '.7rem', color: '#64748b', fontWeight: 800, letterSpacing: 1, marginBottom: 4 }}>{cat}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 6 }}>
                {mks.map(m => {
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
                      <span style={{ fontWeight: 800, fontSize: '.78rem', color: m.probability >= 70 ? '#10b981' : m.probability >= 55 ? '#f59e0b' : '#94a3b8' }}>
                        {m.probability}%
                      </span>
                      {m.odd && <span style={{ fontSize: '.7rem', color: '#22d3ee', fontFamily: 'JetBrains Mono, monospace' }}>@{m.odd}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Auto combinada (from server) */}
          {a.combinada && (
            <div style={{
              marginTop: 14, padding: 10, borderRadius: 10,
              background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)',
            }}>
              <div style={{ fontSize: '.78rem', fontWeight: 800, color: '#f59e0b', marginBottom: 6 }}>
                Combinada sugerida ({a.combinada.combinedProbability}%{a.combinada.combinedOdd ? ` @${a.combinada.combinedOdd}` : ''})
              </div>
              {(a.combinada.selections || []).map((s, i) => (
                <div key={i} style={{ fontSize: '.78rem', color: '#cbd5e1', padding: '3px 0' }}>
                  • {s.market}: {s.pick} — {s.probability}%{s.odd ? ` @${s.odd}` : ''}
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <a
              href={`/dashboard/baseball/analisis/${game.id}`}
              style={{ ...btn('#22d3ee'), textDecoration: 'none', display: 'inline-block' }}
            >Ver detalle completo →</a>
            <button onClick={(e) => onDismiss(e, game.id)} style={btn('#ef4444')}>✕ Quitar</button>
          </div>
        </div>
      )}
    </div>
  );
}

function CombinadaTab({ customCombinada, onClear, onRemove }) {
  if (!customCombinada || customCombinada.selections.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>
        <div style={{ fontSize: '2.5rem', opacity: 0.3 }}>🎯</div>
        <p>Tu combinada está vacía.</p>
        <p style={{ fontSize: '.85rem', opacity: 0.7 }}>
          Ve a "Analizados" y selecciona los mercados que quieres combinar.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div style={{
        background: 'linear-gradient(135deg,rgba(34,211,238,0.12),rgba(245,158,11,0.06))',
        border: '1px solid rgba(34,211,238,0.4)', borderRadius: 14, padding: 16, marginBottom: 14,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontWeight: 800, color: '#22d3ee' }}>🎯 Mi combinada</span>
          <div style={{ display: 'flex', gap: 14, alignItems: 'baseline' }}>
            <span style={{ fontSize: '1.5rem', fontWeight: 800, color: '#22d3ee' }}>
              {customCombinada.combinedProbability}%
            </span>
            {customCombinada.combinedOdd && (
              <span style={{ fontSize: '1.2rem', fontWeight: 800, color: '#f59e0b', fontFamily: 'JetBrains Mono, monospace' }}>
                @{customCombinada.combinedOdd}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          {customCombinada.selections.map((s, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 8, alignItems: 'center',
              padding: '8px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.04)',
            }}>
              <div style={{ fontSize: '.78rem' }}>
                <div style={{ color: '#94a3b8' }}>{s.matchName}</div>
                <div style={{ color: '#cbd5e1', fontWeight: 600 }}>{s.label}</div>
              </div>
              <span style={{ fontWeight: 800, color: s.probability >= 70 ? '#10b981' : '#f59e0b' }}>{s.probability}%</span>
              {s.odd && <span style={{ fontFamily: 'JetBrains Mono, monospace', color: '#22d3ee' }}>@{s.odd}</span>}
              <button
                onClick={() => onRemove(s.fixtureId, s.marketKey)}
                style={{ width: 22, height: 22, borderRadius: 4, background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: 'none', cursor: 'pointer', fontSize: 11 }}
              >✕</button>
            </div>
          ))}
        </div>
      </div>
      <button onClick={onClear} style={btn('#ef4444')}>Vaciar combinada</button>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>
      <div style={{ fontSize: '3rem', opacity: 0.3 }}>⚾</div>
      <p>No hay partidos en esta fecha.</p>
      <p style={{ fontSize: '.82rem', opacity: 0.7 }}>
        MLB: Mar–Oct · LIDOM/LVBP/LMP/LBPRC: Oct–Feb · NPB/KBO: Mar–Oct
      </p>
    </div>
  );
}

// =====================================================================
// STYLES
// =====================================================================
const btn = (color) => ({
  padding: '6px 12px', borderRadius: 8, fontSize: '.82rem', fontWeight: 700,
  background: color ? `${color}1a` : 'rgba(255,255,255,0.04)',
  border: color ? `1px solid ${color}55` : '1px solid rgba(255,255,255,0.08)',
  color: color || '#cbd5e1', cursor: 'pointer',
});
const tabBtn = (active) => ({
  padding: '8px 14px', borderRadius: 8, fontSize: '.85rem', fontWeight: 700,
  background: active ? 'rgba(245,158,11,0.15)' : 'transparent',
  border: 'none', color: active ? '#f59e0b' : '#94a3b8', cursor: 'pointer',
  display: 'flex', alignItems: 'center', gap: 6,
});
const tabBadge = (active) => ({
  fontSize: '.7rem', padding: '1px 7px', borderRadius: 999,
  background: active ? '#f59e0b' : 'rgba(148,163,184,0.2)',
  color: active ? '#06060b' : '#cbd5e1', fontWeight: 800,
});
const chip = (active) => ({
  padding: '5px 12px', borderRadius: 999, fontSize: '.75rem', fontWeight: 700,
  background: active ? 'rgba(245,158,11,0.18)' : 'rgba(255,255,255,0.03)',
  border: active ? '1px solid #f59e0b' : '1px solid rgba(255,255,255,0.08)',
  color: active ? '#f59e0b' : '#94a3b8', cursor: 'pointer',
});
const miniChip = (color) => ({
  fontSize: '.7rem', padding: '2px 8px', borderRadius: 999,
  background: `${color}1a`, border: `1px solid ${color}33`, color, fontWeight: 700,
});
const badgePill = (color) => ({
  padding: '4px 10px', borderRadius: 999, fontSize: '.7rem', fontWeight: 800,
  background: `${color}1a`, color, border: `1px solid ${color}55`,
});
