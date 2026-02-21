'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

const FLAGS = {
  Germany: '🇩🇪', Spain: '🇪🇸', England: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', Italy: '🇮🇹', Turkey: '🇹🇷',
  Colombia: '🇨🇴', Brazil: '🇧🇷', France: '🇫🇷', 'Saudi Arabia': '🇸🇦', Argentina: '🇦🇷', Mexico: '🇲🇽',
};

const CALLS_PER_ANALYSIS = 5;

const today = () => new Date().toISOString().split('T')[0];
const fmtTime = (d) => new Date(d).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const isLive = (s) => ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'].includes(s);
const statusText = (s) => ({ NS: 'Proximo', '1H': '1T', '2H': '2T', HT: 'HT', FT: 'Final', ET: 'Extra', P: 'Pen', AET: 'Extra', PEN: 'Pen', SUSP: 'Susp', PST: 'Post', CANC: 'Canc' }[s] || s);
const isFinished = (s) => ['FT', 'AET', 'PEN', 'CANC', 'SUSP', 'PST', 'ABD', 'AWD', 'WO'].includes(s);

const LIVE_STORAGE_KEY = 'futbol_live_tracked';

const saveLiveToStorage = (tracked) => {
  try {
    const ids = tracked.map(m => m.fixture.id);
    localStorage.setItem(LIVE_STORAGE_KEY, JSON.stringify({ ids, date: today() }));
  } catch {}
};

const loadLiveFromStorage = () => {
  try {
    const raw = localStorage.getItem(LIVE_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.date !== today()) {
      localStorage.removeItem(LIVE_STORAGE_KEY);
      return null;
    }
    return data;
  } catch { return null; }
};

export default function Home() {
  // TABS: 'partidos' | 'envivo' | 'analizados'
  const [tab, setTab] = useState('partidos');
  const [date, setDate] = useState(today());

  // Partidos tab state
  const [matches, setMatches] = useState([]);
  const [hiddenIds, setHiddenIds] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [countryFilter, setCountryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [genderFilter, setGenderFilter] = useState('');
  const [fromCache, setFromCache] = useState(false);

  // Quota state
  const [quota, setQuota] = useState({ used: 0, remaining: 100, limit: 100 });

  // En Vivo tab state
  const [liveTracked, setLiveTracked] = useState([]);
  const [liveSource, setLiveSource] = useState('');
  const [liveLastUpdate, setLiveLastUpdate] = useState(null);
  const [liveError, setLiveError] = useState(false);
  const [liveRefreshing, setLiveRefreshing] = useState(false);
  const [liveNextRefresh, setLiveNextRefresh] = useState(0);
  const [liveInterval, setLiveInterval] = useState(60);
  const liveIntervalRef = useRef(null);
  const countdownRef = useRef(null);
  const hasRestoredRef = useRef(false);
  const pendingRemovalsRef = useRef(new Set());
  const prevScoresRef = useRef({});
  const [notifPermission, setNotifPermission] = useState('default');

  // Analizados tab state
  const [savedAnalyses, setSavedAnalyses] = useState([]);
  const [savedMatches, setSavedMatches] = useState({});
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyDates, setHistoryDates] = useState([]);
  const [historyDate, setHistoryDate] = useState(today());

  const requestNotifPermission = useCallback(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission === 'granted') { setNotifPermission('granted'); return; }
    if (Notification.permission === 'denied') { setNotifPermission('denied'); return; }
    Notification.requestPermission().then(p => setNotifPermission(p)).catch(() => {});
  }, []);

  const notifyScoreChange = useCallback((match, oldHome, oldAway, newHome, newAway) => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    const homeName = match.teams?.home?.name || '?';
    const awayName = match.teams?.away?.name || '?';
    const homeScored = newHome > oldHome;
    const awayScored = newAway > oldAway;
    const scorer = homeScored && awayScored ? 'Doble GOL!' : homeScored ? `GOL ${homeName}!` : `GOL ${awayName}!`;
    try {
      new Notification(scorer, {
        body: `${homeName} ${newHome} - ${newAway} ${awayName}`,
        icon: match.league?.logo || undefined,
        tag: `goal-${match.fixture.id}-${newHome}-${newAway}`,
      });
    } catch {}
  }, []);

  useEffect(() => {
    fetch('/api/hide').then(r => r.json()).then(d => setHiddenIds(d.hidden || [])).catch(() => {});
    fetch('/api/quota').then(r => r.json()).then(q => setQuota(q)).catch(() => {});
    loadMatches(today());
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setNotifPermission(Notification.permission);
    }
  }, []);

  // Restore live tracked from localStorage
  useEffect(() => {
    const stored = loadLiveFromStorage();
    if (!stored || stored.ids.length === 0) { hasRestoredRef.current = true; return; }
    fetch(`/api/live?date=${stored.date}`)
      .then(r => r.json())
      .then(data => {
        const idSet = new Set(stored.ids);
        const now = Date.now();
        const restored = (data.matches || []).filter(m => idSet.has(m.fixture.id))
          .map(m => ({ ...m, _liveSource: data.source, _apiElapsed: m.fixture.status.elapsed, _apiTimestamp: now }));
        if (restored.length > 0) {
          const scores = {};
          restored.forEach(m => { scores[m.fixture.id] = { home: m.goals?.home ?? 0, away: m.goals?.away ?? 0 }; });
          prevScoresRef.current = scores;
          setLiveTracked(restored);
          setLiveSource(data.source || 'cache');
        } else {
          localStorage.removeItem(LIVE_STORAGE_KEY);
        }
      })
      .catch(() => { localStorage.removeItem(LIVE_STORAGE_KEY); })
      .finally(() => { hasRestoredRef.current = true; });
  }, []);

  // Sync liveTracked to localStorage
  useEffect(() => {
    if (!hasRestoredRef.current) return;
    if (liveTracked.length > 0) {
      saveLiveToStorage(liveTracked);
    } else {
      localStorage.removeItem(LIVE_STORAGE_KEY);
    }
  }, [liveTracked]);

  // Live tracking auto-refresh via API-Football (dynamic interval based on quota)
  useEffect(() => {
    if (liveTracked.length === 0) return;

    const refresh = async () => {
      setLiveRefreshing(true);
      try {
        const ids = liveTracked.map(m => m.fixture.id).join(',');
        const res = await fetch(`/api/live?date=${date}&ids=${ids}`);
        const data = await res.json();
        setLiveSource(data.source || 'cache');
        setLiveLastUpdate(new Date());
        setLiveError(false);
        if (data.quota) setQuota(data.quota);
        if (data.refreshInterval) setLiveInterval(data.refreshInterval);

        if (data.matches && data.matches.length > 0) {
          const now = Date.now();

          // Detect score changes and notify
          data.matches.forEach(m => {
            const prev = prevScoresRef.current[m.fixture.id];
            const newHome = m.goals?.home ?? 0;
            const newAway = m.goals?.away ?? 0;
            if (prev && (newHome > prev.home || newAway > prev.away)) {
              notifyScoreChange(m, prev.home, prev.away, newHome, newAway);
            }
            prevScoresRef.current[m.fixture.id] = { home: newHome, away: newAway };
          });

          // Update tracked matches with fresh data
          setLiveTracked(prev => prev.map(old => {
            const fresh = data.matches.find(u => u.fixture.id === old.fixture.id);
            return fresh ? { ...fresh, _apiElapsed: fresh.fixture.status.elapsed, _apiTimestamp: now } : old;
          }));

          // Auto-remove finished matches after 18s
          data.matches.forEach(m => {
            if (isFinished(m.fixture.status.short) && !pendingRemovalsRef.current.has(m.fixture.id)) {
              pendingRemovalsRef.current.add(m.fixture.id);
              setTimeout(() => {
                setLiveTracked(prev => prev.filter(t => t.fixture.id !== m.fixture.id));
                delete prevScoresRef.current[m.fixture.id];
                pendingRemovalsRef.current.delete(m.fixture.id);
              }, 18000);
            }
          });
        }
        setLiveNextRefresh(data.refreshInterval || liveInterval);
      } catch {
        setLiveError(true);
      } finally {
        setLiveRefreshing(false);
      }
    };

    refresh();
    const ms = liveInterval * 1000;
    liveIntervalRef.current = setInterval(refresh, ms);

    return () => { if (liveIntervalRef.current) clearInterval(liveIntervalRef.current); };
  }, [liveTracked.length, date, liveInterval]);

  // Countdown timer for next refresh
  useEffect(() => {
    if (liveTracked.length > 0 && liveNextRefresh > 0) {
      countdownRef.current = setInterval(() => {
        setLiveNextRefresh(prev => (prev > 0 ? prev - 1 : 0));
      }, 1000);
    }
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [liveTracked.length, liveNextRefresh > 0]);

  // Load history dates when switching to analizados tab
  useEffect(() => {
    if (tab === 'analizados') loadHistoryDates();
  }, [tab]);

  const loadMatches = useCallback(async (d) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/matches?date=${d}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setMatches(data.matches || []);
      setFromCache(data.fromCache);
      if (data.quota) setQuota(data.quota);
      setSelected(new Set());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const changeDate = (offset) => {
    const d = new Date(date);
    d.setDate(d.getDate() + offset);
    const nd = d.toISOString().split('T')[0];
    setDate(nd);
    loadMatches(nd);
  };

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(m => m.fixture.id)));
    }
  };

  // Send selected matches to En Vivo tab
  const sendToLive = () => {
    const toTrack = filtered.filter(m => selected.has(m.fixture.id));
    if (toTrack.length === 0) return;

    requestNotifPermission();

    toTrack.forEach(m => {
      if (!prevScoresRef.current[m.fixture.id]) {
        prevScoresRef.current[m.fixture.id] = { home: m.goals?.home ?? 0, away: m.goals?.away ?? 0 };
      }
    });

    const now = Date.now();
    setLiveTracked(prev => {
      const existingIds = new Set(prev.map(m => m.fixture.id));
      const newOnes = toTrack.filter(m => !existingIds.has(m.fixture.id))
        .map(m => ({ ...m, _apiElapsed: m.fixture.status.elapsed, _apiTimestamp: now }));
      return [...prev, ...newOnes];
    });
    setSelected(new Set());
    setTab('envivo');
  };

  const removeFromLive = (fixtureId) => {
    delete prevScoresRef.current[fixtureId];
    pendingRemovalsRef.current.delete(fixtureId);
    setLiveTracked(prev => prev.filter(m => m.fixture.id !== fixtureId));
  };

  const analyzeBatch = async () => {
    const toAnalyze = filtered.filter(m => selected.has(m.fixture.id));
    if (toAnalyze.length === 0) return;

    setAnalyzing(true);

    try {
      const payload = toAnalyze.map(m => ({
        fixtureId: m.fixture.id,
        homeId: m.teams.home.id,
        awayId: m.teams.away.id,
        leagueId: m.league.id,
        season: m.league.season,
        date,
      }));

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matches: payload }),
      });

      const data = await res.json();

      if (data.quota) setQuota(data.quota);

      if (data.error && res.status === 429) {
        alert(data.error);
        return;
      }

      const matchMap = {};
      toAnalyze.forEach(m => { matchMap[m.fixture.id] = m; });
      setSavedMatches(prev => ({ ...prev, ...matchMap }));
      setSavedAnalyses(prev => {
        const newEntries = Object.entries(data.results || {}).map(([fid, analysis]) => ({
          match: matchMap[Number(fid)] || matchMap[fid],
          analysis,
        }));
        const existing = prev.filter(e => !(data.results || {})[e.match?.fixture?.id]);
        return [...existing, ...newEntries];
      });

      setTab('analizados');
      setSelected(new Set());
    } catch (e) {
      console.error(e);
    } finally {
      setAnalyzing(false);
    }
  };

  const loadHistoryDates = async () => {
    try {
      const res = await fetch('/api/history');
      const data = await res.json();
      setHistoryDates(data.dates || []);
    } catch {}
  };

  const loadHistory = async (d) => {
    setLoadingHistory(true);
    setHistoryDate(d);
    try {
      const [histRes, matchRes] = await Promise.all([
        fetch(`/api/history?date=${d}`).then(r => r.json()),
        fetch(`/api/matches?date=${d}`).then(r => r.json()),
      ]);

      const analyses = histRes.analyses || [];
      const matchList = matchRes.matches || [];
      if (matchRes.quota) setQuota(matchRes.quota);

      const matchById = {};
      matchList.forEach(m => { matchById[m.fixture.id] = m; });

      const combined = analyses.map(a => ({
        match: matchById[a.fixtureId] || null,
        analysis: a,
      })).filter(e => e.match);

      setSavedAnalyses(combined);
      setSavedMatches(matchById);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingHistory(false);
    }
  };

  const doHide = async (e, fixtureId) => {
    e.stopPropagation();
    setHiddenIds(prev => [...prev, fixtureId]);
    setSelected(prev => { const n = new Set(prev); n.delete(fixtureId); return n; });
    try {
      await fetch('/api/hide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fixtureId }) });
    } catch {}
  };

  const filtered = matches.filter(m => {
    if (hiddenIds.includes(m.fixture.id)) return false;
    const meta = m.leagueMeta || {};
    if (countryFilter && meta.country !== countryFilter) return false;
    if (genderFilter && meta.gender !== genderFilter) return false;
    if (statusFilter === 'live' && !isLive(m.fixture.status.short)) return false;
    if (statusFilter === 'upcoming' && m.fixture.status.short !== 'NS') return false;
    if (statusFilter === 'finished' && m.fixture.status.short !== 'FT') return false;
    return true;
  });

  const liveCount = filtered.filter(m => isLive(m.fixture.status.short)).length;

  // Quota calculations
  const analysisCallsCost = selected.size * CALLS_PER_ANALYSIS;
  const canAffordAnalysis = quota.remaining >= analysisCallsCost && selected.size > 0;
  const maxAnalyzable = Math.floor(quota.remaining / CALLS_PER_ANALYSIS);
  const quotaPercent = Math.round((quota.used / quota.limit) * 100);
  const quotaColor = quotaPercent >= 90 ? 'var(--red)' : quotaPercent >= 70 ? 'var(--orange)' : 'var(--accent)';

  return (
    <div className="app">
      <div className="container">
        {/* HEADER */}
        <div className="header">
          <div className="header-top">
            <h1>Futbol Analysis</h1>
            <div className="header-badges">
              <span className="badge badge-cache">{fromCache ? 'Cache' : 'API'}</span>
              <span className="badge badge-api" style={{ borderColor: quotaColor, color: quotaColor }}>
                API: {quota.remaining}/{quota.limit}
              </span>
              <span className="badge badge-count">{filtered.length} partidos</span>
            </div>
          </div>
          {/* Quota bar */}
          <div style={{ marginTop: 10, position: 'relative', zIndex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'rgba(255,255,255,0.6)', marginBottom: 3 }}>
              <span>API-Football: {quota.used} usadas hoy</span>
              <span>Max analisis: {maxAnalyzable} partidos</span>
            </div>
            <div style={{ height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${quotaPercent}%`, background: quotaColor, borderRadius: 2, transition: 'width 0.3s' }} />
            </div>
          </div>
        </div>

        {/* TABS */}
        <div className="tabs">
          <button className={`tab ${tab === 'partidos' ? 'active' : ''}`} onClick={() => setTab('partidos')}>
            Partidos
            {liveCount > 0 && <span className="tab-live">{liveCount}</span>}
          </button>
          <button className={`tab ${tab === 'envivo' ? 'active' : ''}`} onClick={() => setTab('envivo')}>
            En Vivo
            {liveTracked.length > 0 && <span className="tab-live">{liveTracked.length}</span>}
          </button>
          <button className={`tab ${tab === 'analizados' ? 'active' : ''}`} onClick={() => setTab('analizados')}>
            Analizados
            {savedAnalyses.length > 0 && <span className="tab-count">{savedAnalyses.length}</span>}
          </button>
        </div>

        {/* ==================== TAB: PARTIDOS ==================== */}
        {tab === 'partidos' && (
          <>
            {/* STATS */}
            <div className="stats-bar">
              <div className="stat-pill"><div className="label">Partidos</div><div className="value green">{filtered.length}</div></div>
              <div className="stat-pill"><div className="label">En Vivo</div><div className="value red">{liveCount}</div></div>
              <div className="stat-pill"><div className="label">Selec.</div><div className="value blue">{selected.size}</div></div>
              <div className="stat-pill"><div className="label">Ocultos</div><div className="value muted">{hiddenIds.length}</div></div>
            </div>

            {/* DATE NAV */}
            <div className="date-nav">
              <button onClick={() => changeDate(-1)}>&#9664;</button>
              <div className="date-display">
                {new Date(date + 'T12:00:00').toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' })}
              </div>
              <button onClick={() => changeDate(1)}>&#9654;</button>
            </div>

            {/* TOOLBAR */}
            <div className="toolbar">
              <select value={countryFilter} onChange={e => setCountryFilter(e.target.value)}>
                <option value="">Todos</option>
                {Object.entries(FLAGS).map(([c, f]) => <option key={c} value={c}>{f} {c}</option>)}
              </select>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="">Estado</option>
                <option value="live">En Vivo</option>
                <option value="upcoming">Proximos</option>
                <option value="finished">Finalizados</option>
              </select>
              <select value={genderFilter} onChange={e => setGenderFilter(e.target.value)}>
                <option value="">M/F</option>
                <option value="M">Masc</option>
                <option value="W">Fem</option>
              </select>
              <button className="btn btn-primary" onClick={() => loadMatches(date)} disabled={loading}>
                {loading ? 'Cargando...' : 'Cargar'}
              </button>
            </div>

            {loading && <div className="loader"><div className="spinner-ring" /><p>Cargando partidos...</p></div>}

            {!loading && filtered.length === 0 && (
              <div className="empty"><h3>Sin partidos</h3><p>No hay partidos para esta fecha</p></div>
            )}

            {!loading && filtered.length > 0 && (
              <div className="select-all-row">
                <label>
                  <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={selectAll} />
                  Seleccionar todos ({filtered.length})
                </label>
                {maxAnalyzable < filtered.length && (
                  <span style={{ fontSize: '0.7rem', color: 'var(--orange)', fontWeight: 600 }}>
                    Solo puedes analizar {maxAnalyzable} partidos hoy
                  </span>
                )}
              </div>
            )}

            <div className="match-list">
              {filtered.map(match => (
                <MatchRow
                  key={match.fixture.id}
                  match={match}
                  isSelected={selected.has(match.fixture.id)}
                  onToggle={() => toggleSelect(match.fixture.id)}
                  onHide={(e) => doHide(e, match.fixture.id)}
                />
              ))}
            </div>

            {selected.size > 0 && (
              <div className="selection-bar">
                <div>
                  <div className="count">{selected.size} seleccionados</div>
                  <div className="api-cost">
                    {canAffordAnalysis
                      ? `~${analysisCallsCost} API calls (quedan ${quota.remaining})`
                      : `Limite: solo puedes analizar ${maxAnalyzable}`
                    }
                  </div>
                </div>
                <button className="btn btn-primary" onClick={analyzeBatch} disabled={analyzing || !canAffordAnalysis}>
                  {analyzing ? 'Analizando...' : !canAffordAnalysis ? 'Sin cuota' : 'Analizar'}
                </button>
                <button className="btn btn-blue" onClick={sendToLive}>
                  En Vivo
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Limpiar</button>
              </div>
            )}
          </>
        )}

        {/* ==================== TAB: EN VIVO ==================== */}
        {tab === 'envivo' && (
          <div className="live-view">
            {/* Connection status bar */}
            {liveTracked.length > 0 && (
              <div className={`live-conn-bar ${liveError ? 'error' : liveSource === 'cache' ? 'cache' : 'ok'}`}>
                <div className="live-conn-left">
                  {liveRefreshing
                    ? <span className="conn-dot syncing" />
                    : <span className={`conn-dot ${liveError ? 'error' : 'ok'}`} />
                  }
                  <span>
                    {liveRefreshing ? 'Sincronizando...' : liveError ? 'Error de conexion' :
                      liveSource === 'api-football' ? `API-Football (cada ${liveInterval}s)` :
                      `Cache — proximo sync en ${liveNextRefresh}s`}
                  </span>
                </div>
                <div className="live-conn-right">
                  {liveLastUpdate && (
                    <span>Sync: {liveLastUpdate.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                  )}
                  {liveNextRefresh > 0 && !liveRefreshing && (
                    <span className="conn-countdown">{liveNextRefresh}s</span>
                  )}
                  <button className="live-clear-btn" onClick={() => { setLiveTracked([]); setLiveSource(''); setLiveLastUpdate(null); prevScoresRef.current = {}; pendingRemovalsRef.current.clear(); }}>
                    Limpiar
                  </button>
                </div>
              </div>
            )}

            {liveTracked.length === 0 && (
              <div className="empty">
                <h3>Sin partidos en seguimiento</h3>
                <p>Ve a "Partidos", selecciona los que quieras seguir y presiona "En Vivo"</p>
                <button className="btn btn-outline-accent" style={{ marginTop: 16 }} onClick={() => setTab('partidos')}>
                  Ir a Partidos
                </button>
              </div>
            )}

            <div className="live-grid">
              {liveTracked.map(match => (
                <LiveMatchCard key={match.fixture.id} match={match} onRemove={() => removeFromLive(match.fixture.id)} />
              ))}
            </div>
          </div>
        )}

        {/* ==================== TAB: ANALIZADOS ==================== */}
        {tab === 'analizados' && (
          <div className="analizados-view">
            <div className="history-bar">
              <div className="history-bar-left">
                <h2>Partidos Analizados</h2>
                <p className="subtitle">Guardados en Sanity — consultables en cualquier momento</p>
              </div>
              <div className="history-bar-right">
                <select value={historyDate} onChange={e => { setHistoryDate(e.target.value); loadHistory(e.target.value); }}>
                  <option value={today()}>Hoy</option>
                  {historyDates.filter(d => d !== today()).map(d => (
                    <option key={d} value={d}>{new Date(d + 'T12:00:00').toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })}</option>
                  ))}
                </select>
                <button className="btn btn-outline-accent btn-sm" onClick={() => loadHistory(historyDate)}>
                  {loadingHistory ? 'Cargando...' : 'Cargar historial'}
                </button>
              </div>
            </div>

            {analyzing && (
              <div className="loader">
                <div className="spinner-ring" />
                <p>Analizando partidos... esto puede tomar unos segundos</p>
              </div>
            )}

            {loadingHistory && (
              <div className="loader"><div className="spinner-ring" /><p>Cargando historial...</p></div>
            )}

            {!analyzing && !loadingHistory && savedAnalyses.length === 0 && (
              <div className="empty">
                <h3>Sin analisis guardados</h3>
                <p>Selecciona partidos en la pestana "Partidos" y haz clic en "Analizar"</p>
                <button className="btn btn-outline-accent" style={{ marginTop: 16 }} onClick={() => loadHistory(historyDate)}>
                  Buscar en historial
                </button>
              </div>
            )}

            {!analyzing && !loadingHistory && savedAnalyses.map((entry, idx) => (
              entry.match && <AnalysisCard key={entry.match.fixture?.id || idx} match={entry.match} analysis={entry.analysis} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ==================== MATCH ROW ====================
function MatchRow({ match, isSelected, onToggle, onHide }) {
  const live = isLive(match.fixture.status.short);
  const meta = match.leagueMeta || {};
  const flag = FLAGS[meta.country] || '';
  const hasScore = live || ['FT', 'AET', 'PEN'].includes(match.fixture.status.short);

  return (
    <div className={`match-row ${isSelected ? 'selected' : ''} ${live ? 'live' : ''}`} onClick={onToggle}>
      <div className="check-box">
        <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
      </div>
      <div className="match-row-content">
        <div className="match-row-top">
          <div className="match-league">
            {match.league.logo && <img src={match.league.logo} alt="" />}
            <span>{flag} {match.league.name}</span>
            {meta.gender === 'W' && <span className="gender-tag">Fem</span>}
          </div>
          <div className="match-meta">
            <span className={`match-time-badge ${live ? 'live' : ''}`}>
              {live ? `${match.fixture.status.elapsed || ''}\' ${statusText(match.fixture.status.short)}` : fmtTime(match.fixture.date)}
            </span>
          </div>
        </div>
        <div className="match-teams">
          <div className="match-team">
            {match.teams.home.logo && <img src={match.teams.home.logo} alt="" />}
            <span className="name">{match.teams.home.name}</span>
          </div>
          <div className={`match-score ${!hasScore ? 'pending' : ''}`}>
            {hasScore ? `${match.goals.home} - ${match.goals.away}` : 'VS'}
          </div>
          <div className="match-team away">
            {match.teams.away.logo && <img src={match.teams.away.logo} alt="" />}
            <span className="name">{match.teams.away.name}</span>
          </div>
        </div>
      </div>
      <div className="match-row-actions">
        <button className="btn-hide-x" onClick={onHide} title="Ocultar">&times;</button>
      </div>
    </div>
  );
}

// ==================== LIVE CLOCK (synced with API) ====================
function LiveClock({ elapsed, status, apiTimestamp }) {
  const [display, setDisplay] = useState('');

  useEffect(() => {
    if (!isLive(status)) {
      if (status === 'HT') setDisplay('Entretiempo');
      else setDisplay(statusText(status));
      return;
    }

    const baseMin = elapsed || 0;
    const baseTime = apiTimestamp || Date.now();

    const tick = () => {
      const secsSinceUpdate = Math.max(0, Math.floor((Date.now() - baseTime) / 1000));
      const currentMin = baseMin + Math.floor(secsSinceUpdate / 60);
      const currentSec = secsSinceUpdate % 60;
      const is1H = status === '1H';
      const is2H = status === '2H';

      if (is1H && currentMin >= 45) {
        const added = currentMin - 45;
        setDisplay(`45+${added}:${String(currentSec).padStart(2, '0')}`);
      } else if (is2H && currentMin >= 90) {
        const added = currentMin - 90;
        setDisplay(`90+${added}:${String(currentSec).padStart(2, '0')}`);
      } else {
        setDisplay(`${currentMin}:${String(currentSec).padStart(2, '0')}`);
      }
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [elapsed, status, apiTimestamp]);

  return <span>{display}</span>;
}

// ==================== LIVE MATCH CARD ====================
function LiveMatchCard({ match, onRemove }) {
  const live = isLive(match.fixture.status.short);
  const finished = isFinished(match.fixture.status.short);
  const meta = match.leagueMeta || {};
  const flag = FLAGS[meta.country] || '';
  const hasScore = live || finished;
  const source = match._liveSource === 'bzzoiro' ? 'Bzzoiro' : match._liveSource === 'api-football' ? 'API' : 'Cache';
  const status = match.fixture.status.short;

  const elapsed = match._apiElapsed || match.fixture.status.elapsed || 0;
  const maxMin = status === '1H' ? 45 : 90;
  const progress = Math.min(100, (elapsed / maxMin) * 100);

  return (
    <div className={`live-card ${live ? 'is-live' : ''} ${finished ? 'is-finished' : ''}`}>
      {/* Top bar: league + clock */}
      <div className="live-card-top">
        <div className="live-card-league">
          {match.league.logo && <img src={match.league.logo} alt="" />}
          <span>{flag} {match.league.name}</span>
          {meta.gender === 'W' && <span className="gender-tag">Fem</span>}
        </div>
        <div className="live-card-status">
          <span className="live-source-tag">{source}</span>
          {live && <span className="live-pulse" />}
          <span className={`live-clock-display ${live ? 'ticking' : ''}`}>
            {live
              ? <LiveClock elapsed={elapsed} status={status} apiTimestamp={match._apiTimestamp} />
              : finished ? statusText(status) : fmtTime(match.fixture.date)
            }
          </span>
          {live && <span className="live-badge-sm">LIVE</span>}
        </div>
      </div>

      {/* Score area */}
      <div className="live-card-score-area">
        <div className="live-card-team">
          {match.teams.home.logo && <img src={match.teams.home.logo} alt="" />}
          <span className="live-team-name">{match.teams.home.name}</span>
        </div>
        <div className={`live-card-score ${live ? 'glow' : ''} ${!hasScore ? 'pending' : ''}`}>
          {hasScore ? (
            <>
              <span className="score-num">{match.goals.home}</span>
              <span className="score-sep">-</span>
              <span className="score-num">{match.goals.away}</span>
            </>
          ) : <span className="score-vs">VS</span>}
        </div>
        <div className="live-card-team away">
          {match.teams.away.logo && <img src={match.teams.away.logo} alt="" />}
          <span className="live-team-name">{match.teams.away.name}</span>
        </div>
      </div>

      {/* Progress bar + remove button */}
      <div className="live-card-bottom">
        {live && (
          <div className="live-progress-track">
            <div className="live-progress-fill" style={{ width: `${progress}%` }} />
            <span className="live-progress-label">{status === '1H' ? '1T' : '2T'}</span>
          </div>
        )}
        {!live && <div style={{ flex: 1 }} />}
        <button className="live-remove-btn" onClick={onRemove} title="Quitar">&times;</button>
      </div>
    </div>
  );
}

// ==================== ANALYSIS CARD ====================
function AnalysisCard({ match, analysis }) {
  const [collapsed, setCollapsed] = useState(false);
  const live = isLive(match.fixture?.status?.short || '');
  const meta = match.leagueMeta || {};
  const flag = FLAGS[meta.country] || '';
  const hasScore = live || ['FT', 'AET', 'PEN'].includes(match.fixture?.status?.short || '');

  if (!analysis || analysis.error) {
    return (
      <div className="analysis-card">
        <div className="analysis-card-header">
          <div className="league">
            {match.league?.logo && <img src={match.league.logo} alt="" />}
            <span>{flag} {match.league?.name}</span>
          </div>
        </div>
        <div className="analysis-card-teams">
          <div className="analysis-team">
            {match.teams?.home?.logo && <img src={match.teams.home.logo} alt="" />}
            <span className="name">{match.teams?.home?.name}</span>
          </div>
          <div className="analysis-vs">VS</div>
          <div className="analysis-team">
            {match.teams?.away?.logo && <img src={match.teams.away.logo} alt="" />}
            <span className="name">{match.teams?.away?.name}</span>
          </div>
        </div>
        <div style={{ padding: '0 20px 20px', textAlign: 'center', color: 'var(--orange)', fontSize: '0.8rem' }}>
          {analysis?.error || 'Error al cargar analisis'}
        </div>
      </div>
    );
  }

  const { homeStats, awayStats, h2h, odds, injuries, betterForm } = analysis;

  return (
    <div className="analysis-card">
      <div className="analysis-card-header" onClick={() => setCollapsed(!collapsed)} style={{ cursor: 'pointer' }}>
        <div className="league">
          {match.league?.logo && <img src={match.league.logo} alt="" />}
          <span>{flag} {match.league?.name}</span>
          {meta.gender === 'W' && <span className="gender-tag">Fem</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="time-label">
            {live ? `${match.fixture?.status?.elapsed}\' ${statusText(match.fixture?.status?.short)}` : fmtTime(match.fixture?.date)}
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: '1rem' }}>{collapsed ? '+' : '−'}</span>
        </div>
      </div>

      <div className="analysis-card-teams">
        <div className="analysis-team">
          {match.teams?.home?.logo && <img src={match.teams.home.logo} alt="" />}
          <span className="name">{match.teams?.home?.name}</span>
          {betterForm === 'home' && <span className="best-badge">Mejor Forma</span>}
        </div>
        <div className="analysis-vs">
          {hasScore ? `${match.goals?.home} - ${match.goals?.away}` : 'VS'}
        </div>
        <div className="analysis-team">
          {match.teams?.away?.logo && <img src={match.teams.away.logo} alt="" />}
          <span className="name">{match.teams?.away?.name}</span>
          {betterForm === 'away' && <span className="best-badge">Mejor Forma</span>}
        </div>
      </div>

      {!collapsed && (
        <div className="analysis-card-body">
          <div className="stats-comparison">
            <TeamStats team={match.teams?.home} stats={homeStats} isBest={betterForm === 'home'} />
            <TeamStats team={match.teams?.away} stats={awayStats} isBest={betterForm === 'away'} />
          </div>
          <div className="extra-panels">
            <H2HPanel h2h={h2h} homeId={match.teams?.home?.id} homeName={match.teams?.home?.name} />
            <InjuriesPanel injuries={injuries} homeId={match.teams?.home?.id} awayId={match.teams?.away?.id} />
            <OddsPanel odds={odds} />
          </div>
        </div>
      )}
    </div>
  );
}

// ==================== TEAM STATS ====================
function TeamStats({ team, stats, isBest }) {
  if (!stats || !stats.form) {
    return (
      <div className="team-stats-panel">
        <div className="team-stats-header">
          {team?.logo && <img src={team.logo} alt="" />}
          <div className="info"><div className="team-name">{team?.name || 'Equipo'}</div></div>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Sin datos estadisticos para esta temporada</p>
      </div>
    );
  }

  const pos = stats.league?.standings?.[0]?.rank || '-';
  const form = stats.form || '';
  const played = stats.fixtures?.played?.total || 0;
  const wins = stats.fixtures?.wins?.total || 0;
  const draws = stats.fixtures?.draws?.total || 0;
  const losses = stats.fixtures?.loses?.total || 0;
  const gf = stats.goals?.for?.total?.total || 0;
  const ga = stats.goals?.against?.total?.total || 0;
  const avg = played > 0 ? (gf / played).toFixed(1) : '0';
  const penMiss = stats.penalty?.missed?.total || 0;

  return (
    <div className="team-stats-panel">
      <div className="team-stats-header">
        {team?.logo && <img src={team.logo} alt="" />}
        <div className="info">
          <div className="team-name">{team?.name}</div>
          <div>
            {isBest && <span className="best-badge">Mejor Forma</span>}
            <span className="pos-badge">#{pos}</span>
          </div>
        </div>
      </div>
      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: 4, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' }}>Ultimos 5 partidos</div>
      <div className="form-row">
        {form.split('').slice(-5).map((l, i) => <span key={i} className={`form-dot ${l}`}>{l}</span>)}
      </div>
      <div className="stats-mini-grid">
        <div className="stat-mini"><span className="lbl">PJ</span><span className="val">{played}</span></div>
        <div className="stat-mini"><span className="lbl">V</span><span className="val">{wins}</span></div>
        <div className="stat-mini"><span className="lbl">E</span><span className="val">{draws}</span></div>
        <div className="stat-mini"><span className="lbl">D</span><span className="val">{losses}</span></div>
        <div className="stat-mini"><span className="lbl">Gol/P</span><span className="val">{avg}</span></div>
        <div className="stat-mini"><span className="lbl">GF</span><span className="val">{gf}</span></div>
        <div className="stat-mini"><span className="lbl">GC</span><span className="val">{ga}</span></div>
        <div className="stat-mini"><span className="lbl">Pen F.</span><span className="val">{penMiss}</span></div>
      </div>
    </div>
  );
}

// ==================== H2H ====================
function H2HPanel({ h2h, homeId, homeName }) {
  if (!h2h || h2h.length === 0) return <div className="info-panel"><h4>Historial H2H</h4><p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Sin datos</p></div>;
  const asHome = h2h.filter(m => m.teams?.home?.id === homeId).slice(0, 3);
  const asAway = h2h.filter(m => m.teams?.away?.id === homeId).slice(0, 3);
  return (
    <div className="info-panel">
      <h4>Historial H2H</h4>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: '0.65rem', color: 'var(--blue)', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{homeName} de Local</div>
        {asHome.length > 0 ? asHome.map((m, i) => (
          <div key={i} className="h2h-item">
            <span className="date">{new Date(m.fixture.date).toLocaleDateString('es', { day: '2-digit', month: 'short', year: '2-digit' })}</span>
            <span className="result">{m.goals.home} - {m.goals.away}</span>
          </div>
        )) : <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>—</div>}
      </div>
      <div>
        <div style={{ fontSize: '0.65rem', color: 'var(--orange)', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{homeName} de Visitante</div>
        {asAway.length > 0 ? asAway.map((m, i) => (
          <div key={i} className="h2h-item">
            <span className="date">{new Date(m.fixture.date).toLocaleDateString('es', { day: '2-digit', month: 'short', year: '2-digit' })}</span>
            <span className="result">{m.goals.home} - {m.goals.away}</span>
          </div>
        )) : <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>—</div>}
      </div>
    </div>
  );
}

// ==================== INJURIES ====================
function InjuriesPanel({ injuries, homeId, awayId }) {
  if (!injuries || injuries.length === 0) return <div className="info-panel"><h4>Lesionados / Suspendidos</h4><p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Sin bajas</p></div>;
  const hi = injuries.filter(i => i.team?.id === homeId);
  const ai = injuries.filter(i => i.team?.id === awayId);
  return (
    <div className="info-panel">
      <h4>Lesionados / Suspendidos</h4>
      {hi.length > 0 ? (
        <><div style={{ fontSize: '0.65rem', color: 'var(--blue)', fontWeight: 700, marginBottom: 4 }}>LOCAL</div>
        {hi.map((inj, i) => <div key={i} className="injury-row"><strong>{inj.player.name}</strong> — {inj.player.reason || 'Lesion'}</div>)}</>
      ) : <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6 }}>Local: Sin bajas</div>}
      {ai.length > 0 ? (
        <><div style={{ fontSize: '0.65rem', color: 'var(--orange)', fontWeight: 700, marginBottom: 4, marginTop: 8 }}>VISITANTE</div>
        {ai.map((inj, i) => <div key={i} className="injury-row"><strong>{inj.player.name}</strong> — {inj.player.reason || 'Lesion'}</div>)}</>
      ) : <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 6 }}>Visitante: Sin bajas</div>}
    </div>
  );
}

// ==================== ODDS ====================
function OddsPanel({ odds }) {
  if (!odds?.bookmakers?.length) return <div className="info-panel"><h4>Cuotas</h4><p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>No disponibles</p></div>;
  const bet = odds.bookmakers[0]?.bets?.find(b => b.name === 'Match Winner');
  if (!bet) return <div className="info-panel"><h4>Cuotas</h4><p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>No disponibles</p></div>;
  const h = bet.values.find(v => v.value === 'Home')?.odd || '-';
  const d = bet.values.find(v => v.value === 'Draw')?.odd || '-';
  const a = bet.values.find(v => v.value === 'Away')?.odd || '-';
  return (
    <div className="info-panel">
      <h4>Cuotas</h4>
      <div className="odds-grid">
        <div className="odd-cell"><div className="lbl">Local</div><div className="val">{h}</div></div>
        <div className="odd-cell"><div className="lbl">Empate</div><div className="val">{d}</div></div>
        <div className="odd-cell"><div className="lbl">Visit.</div><div className="val">{a}</div></div>
      </div>
    </div>
  );
}
