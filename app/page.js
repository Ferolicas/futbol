'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

const FLAGS = {
  Germany: '🇩🇪', Spain: '🇪🇸', England: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', Italy: '🇮🇹',
  Colombia: '🇨🇴', Brazil: '🇧🇷', France: '🇫🇷', 'Saudi Arabia': '🇸🇦', Argentina: '🇦🇷', Mexico: '🇲🇽',
};

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
  const [date, setDate] = useState(today());
  const [filter, setFilter] = useState('todos'); // todos | envivo | proximos | finalizados
  const [leagueFilter, setLeagueFilter] = useState('');
  const [genderFilter, setGenderFilter] = useState('');

  // Match data
  const [matches, setMatches] = useState([]);
  const [hiddenIds, setHiddenIds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fromCache, setFromCache] = useState(false);

  // Quota
  const [quota, setQuota] = useState({ used: 0, remaining: 200, limit: 200 });

  // Live tracking
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

  // Initial load
  useEffect(() => {
    fetch('/api/hide').then(r => r.json()).then(d => setHiddenIds(d.hidden || [])).catch(() => {});
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
          if (data.quota) setQuota(data.quota);
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

  // Live refresh function (extracted for manual refresh)
  const doLiveRefresh = useCallback(async () => {
    if (liveTracked.length === 0) return;
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
        data.matches.forEach(m => {
          const prev = prevScoresRef.current[m.fixture.id];
          const newHome = m.goals?.home ?? 0;
          const newAway = m.goals?.away ?? 0;
          if (prev && (newHome > prev.home || newAway > prev.away)) {
            notifyScoreChange(m, prev.home, prev.away, newHome, newAway);
          }
          prevScoresRef.current[m.fixture.id] = { home: newHome, away: newAway };
        });

        setLiveTracked(prev => prev.map(old => {
          const fresh = data.matches.find(u => u.fixture.id === old.fixture.id);
          return fresh ? { ...fresh, _apiElapsed: fresh.fixture.status.elapsed, _apiTimestamp: now } : old;
        }));

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
  }, [liveTracked, date, liveInterval, notifyScoreChange]);

  // Auto-refresh interval
  useEffect(() => {
    if (liveTracked.length === 0) return;
    doLiveRefresh();
    const ms = liveInterval * 1000;
    liveIntervalRef.current = setInterval(doLiveRefresh, ms);
    return () => { if (liveIntervalRef.current) clearInterval(liveIntervalRef.current); };
  }, [liveTracked.length, date, liveInterval]);

  // Countdown timer
  useEffect(() => {
    if (liveTracked.length > 0 && liveNextRefresh > 0) {
      countdownRef.current = setInterval(() => {
        setLiveNextRefresh(prev => (prev > 0 ? prev - 1 : 0));
      }, 1000);
    }
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [liveTracked.length, liveNextRefresh > 0]);

  const manualRefresh = () => {
    if (liveIntervalRef.current) clearInterval(liveIntervalRef.current);
    doLiveRefresh();
    liveIntervalRef.current = setInterval(doLiveRefresh, liveInterval * 1000);
  };

  const loadMatches = useCallback(async (d) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/matches?date=${d}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setMatches(data.matches || []);
      setFromCache(data.fromCache);
      if (data.quota) setQuota(data.quota);
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

  const sendToLive = (match) => {
    requestNotifPermission();
    if (!prevScoresRef.current[match.fixture.id]) {
      prevScoresRef.current[match.fixture.id] = { home: match.goals?.home ?? 0, away: match.goals?.away ?? 0 };
    }
    const now = Date.now();
    setLiveTracked(prev => {
      if (prev.some(m => m.fixture.id === match.fixture.id)) return prev;
      return [...prev, { ...match, _apiElapsed: match.fixture.status.elapsed, _apiTimestamp: now }];
    });
  };

  const removeFromLive = (fixtureId) => {
    delete prevScoresRef.current[fixtureId];
    pendingRemovalsRef.current.delete(fixtureId);
    setLiveTracked(prev => prev.filter(m => m.fixture.id !== fixtureId));
  };

  const clearAllLive = () => {
    setLiveTracked([]);
    setLiveSource('');
    setLiveLastUpdate(null);
    prevScoresRef.current = {};
    pendingRemovalsRef.current.clear();
  };

  const doHide = async (e, fixtureId) => {
    e.stopPropagation();
    setHiddenIds(prev => [...prev, fixtureId]);
    try {
      await fetch('/api/hide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fixtureId }) });
    } catch {}
  };

  // Tracked IDs set for checking
  const trackedIds = new Set(liveTracked.map(m => m.fixture.id));

  // Apply filters
  const filtered = matches.filter(m => {
    if (hiddenIds.includes(m.fixture.id)) return false;
    const meta = m.leagueMeta || {};
    if (leagueFilter && `${meta.country}-${m.league.id}` !== leagueFilter) return false;
    if (genderFilter && meta.gender !== genderFilter) return false;
    if (filter === 'envivo') return isLive(m.fixture.status.short) || trackedIds.has(m.fixture.id);
    if (filter === 'proximos') return m.fixture.status.short === 'NS';
    if (filter === 'finalizados') return isFinished(m.fixture.status.short);
    return true;
  });

  const liveCount = matches.filter(m => !hiddenIds.includes(m.fixture.id) && isLive(m.fixture.status.short)).length;

  // Group matches by league
  const grouped = {};
  filtered.forEach(m => {
    const key = `${m.league.id}`;
    if (!grouped[key]) {
      grouped[key] = {
        league: m.league,
        meta: m.leagueMeta || {},
        matches: [],
      };
    }
    grouped[key].matches.push(m);
  });
  const leagueGroups = Object.values(grouped);

  // Available leagues for dropdown
  const availableLeagues = {};
  matches.filter(m => !hiddenIds.includes(m.fixture.id)).forEach(m => {
    const meta = m.leagueMeta || {};
    const key = `${meta.country}-${m.league.id}`;
    if (!availableLeagues[key]) {
      availableLeagues[key] = { key, name: m.league.name, country: meta.country, flag: FLAGS[meta.country] || '' };
    }
  });

  return (
    <div className="app">
      <div className="container">
        {/* HEADER */}
        <header className="header">
          <h1>Futbol</h1>
          <div className="date-nav">
            <button onClick={() => changeDate(-1)} aria-label="Día anterior">&#9664;</button>
            <div className="date-display">
              {new Date(date + 'T12:00:00').toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' })}
            </div>
            <button onClick={() => changeDate(1)} aria-label="Día siguiente">&#9654;</button>
          </div>
          <button className="btn-reload" onClick={() => loadMatches(date)} disabled={loading}>
            {loading ? '...' : '↻'}
          </button>
        </header>

        {/* LIVE TICKER - shows when there are live tracked matches */}
        {liveTracked.length > 0 && (
          <div className="live-ticker">
            <div className="live-ticker-header">
              <div className="live-ticker-left">
                <span className="live-dot" />
                <span className="live-label">EN VIVO</span>
                <span className="live-count">{liveTracked.length}</span>
              </div>
              <div className="live-ticker-right">
                {liveLastUpdate && (
                  <span className="live-sync">
                    {liveLastUpdate.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                )}
                {liveNextRefresh > 0 && !liveRefreshing && (
                  <span className="live-countdown">{liveNextRefresh}s</span>
                )}
                <button className="btn-sm-action" onClick={manualRefresh} disabled={liveRefreshing}>
                  {liveRefreshing ? '...' : 'Actualizar'}
                </button>
                <button className="btn-sm-action danger" onClick={clearAllLive}>Limpiar</button>
              </div>
            </div>
            <div className="live-ticker-cards">
              {liveTracked.map(match => (
                <LiveMiniCard key={match.fixture.id} match={match} onRemove={() => removeFromLive(match.fixture.id)} />
              ))}
            </div>
          </div>
        )}

        {/* FILTER CHIPS */}
        <div className="filter-bar">
          <div className="chips">
            {[
              { key: 'todos', label: 'Todos' },
              { key: 'envivo', label: 'En Vivo', count: liveCount + liveTracked.length },
              { key: 'proximos', label: 'Próximos' },
              { key: 'finalizados', label: 'Finalizados' },
            ].map(c => (
              <button
                key={c.key}
                className={`chip ${filter === c.key ? 'active' : ''}`}
                onClick={() => setFilter(c.key)}
              >
                {c.label}
                {c.count > 0 && <span className="chip-count">{c.count}</span>}
              </button>
            ))}
          </div>
          <div className="filters">
            <select value={leagueFilter} onChange={e => setLeagueFilter(e.target.value)}>
              <option value="">Liga</option>
              {Object.values(availableLeagues).sort((a, b) => a.name.localeCompare(b.name)).map(l => (
                <option key={l.key} value={l.key}>{l.flag} {l.name}</option>
              ))}
            </select>
            <div className="gender-toggle">
              <button className={`toggle-btn ${genderFilter === '' ? 'active' : ''}`} onClick={() => setGenderFilter('')}>Todos</button>
              <button className={`toggle-btn ${genderFilter === 'M' ? 'active' : ''}`} onClick={() => setGenderFilter('M')}>M</button>
              <button className={`toggle-btn ${genderFilter === 'W' ? 'active' : ''}`} onClick={() => setGenderFilter('W')}>F</button>
            </div>
          </div>
        </div>

        {/* LOADING */}
        {loading && <div className="loader"><div className="spinner" /><p>Cargando partidos...</p></div>}

        {/* EMPTY STATE */}
        {!loading && filtered.length === 0 && (
          <div className="empty">
            <h3>Sin partidos</h3>
            <p>No hay partidos para esta fecha con los filtros seleccionados</p>
          </div>
        )}

        {/* MATCH LIST - Grouped by league */}
        {!loading && leagueGroups.map(group => (
          <div key={group.league.id} className="league-group">
            <div className="league-header">
              {group.league.logo && <img src={group.league.logo} alt="" className="league-logo" />}
              <span className="league-name">{FLAGS[group.meta.country] || ''} {group.league.name}</span>
              {group.meta.gender === 'W' && <span className="gender-tag">F</span>}
              <span className="league-count">{group.matches.length}</span>
            </div>
            {group.matches.map(match => (
              <MatchRow
                key={match.fixture.id}
                match={match}
                isTracked={trackedIds.has(match.fixture.id)}
                onTrack={() => sendToLive(match)}
                onHide={(e) => doHide(e, match.fixture.id)}
              />
            ))}
          </div>
        ))}

        {/* FOOTER */}
        <div className="footer">
          <span>API: {quota.used}/{quota.limit}</span>
          <span>{fromCache ? 'Cache' : 'API'}</span>
        </div>
      </div>
    </div>
  );
}

// ==================== MATCH ROW ====================
function MatchRow({ match, isTracked, onTrack, onHide }) {
  const live = isLive(match.fixture.status.short);
  const finished = isFinished(match.fixture.status.short);
  const hasScore = live || finished;

  return (
    <div className={`match-row ${live ? 'live' : ''} ${finished ? 'finished' : ''}`}>
      <div className="match-time">
        {live ? (
          <span className="time-live">{match.fixture.status.elapsed || ''}&apos;</span>
        ) : finished ? (
          <span className="time-ft">{statusText(match.fixture.status.short)}</span>
        ) : (
          <span className="time-ns">{fmtTime(match.fixture.date)}</span>
        )}
      </div>
      <div className="match-teams-col">
        <div className="team-line">
          {match.teams.home.logo && <img src={match.teams.home.logo} alt="" />}
          <span className="team-name">{match.teams.home.name}</span>
        </div>
        <div className="team-line">
          {match.teams.away.logo && <img src={match.teams.away.logo} alt="" />}
          <span className="team-name">{match.teams.away.name}</span>
        </div>
      </div>
      <div className="match-score-col">
        {hasScore ? (
          <>
            <span className={`score ${live ? 'live' : ''}`}>{match.goals.home}</span>
            <span className={`score ${live ? 'live' : ''}`}>{match.goals.away}</span>
          </>
        ) : (
          <>
            <span className="score empty">-</span>
            <span className="score empty">-</span>
          </>
        )}
      </div>
      <div className="match-actions">
        <button
          className={`btn-track ${isTracked ? 'tracked' : ''}`}
          onClick={onTrack}
          title={isTracked ? 'Ya en seguimiento' : 'Seguir en vivo'}
          disabled={isTracked}
        >
          {isTracked ? '●' : '◉'}
        </button>
        <a
          href="https://streamtp10.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-stream"
          title="Ver streaming"
          onClick={e => e.stopPropagation()}
        >
          ▶
        </a>
        <button className="btn-hide" onClick={onHide} title="Ocultar">×</button>
      </div>
    </div>
  );
}

// ==================== LIVE CLOCK ====================
function LiveClock({ elapsed, status, apiTimestamp }) {
  const [display, setDisplay] = useState('');

  useEffect(() => {
    if (!isLive(status)) {
      if (status === 'HT') setDisplay('HT');
      else setDisplay(statusText(status));
      return;
    }

    const baseMin = elapsed || 0;
    const baseTime = apiTimestamp || Date.now();

    const tick = () => {
      const secsSinceUpdate = Math.max(0, Math.floor((Date.now() - baseTime) / 1000));
      const currentMin = baseMin + Math.floor(secsSinceUpdate / 60);
      const currentSec = secsSinceUpdate % 60;

      if (status === '1H' && currentMin >= 45) {
        setDisplay(`45+${currentMin - 45}:${String(currentSec).padStart(2, '0')}`);
      } else if (status === '2H' && currentMin >= 90) {
        setDisplay(`90+${currentMin - 90}:${String(currentSec).padStart(2, '0')}`);
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

// ==================== LIVE MINI CARD (ticker) ====================
function LiveMiniCard({ match, onRemove }) {
  const live = isLive(match.fixture.status.short);
  const finished = isFinished(match.fixture.status.short);
  const hasScore = live || finished;
  const status = match.fixture.status.short;
  const elapsed = match._apiElapsed || match.fixture.status.elapsed || 0;

  return (
    <div className={`live-mini ${live ? 'is-live' : ''} ${finished ? 'is-finished' : ''}`}>
      <div className="live-mini-status">
        {live ? (
          <>
            <span className="mini-dot" />
            <LiveClock elapsed={elapsed} status={status} apiTimestamp={match._apiTimestamp} />
          </>
        ) : finished ? (
          <span className="mini-ft">{statusText(status)}</span>
        ) : (
          <span className="mini-ns">{fmtTime(match.fixture.date)}</span>
        )}
      </div>
      <div className="live-mini-teams">
        <div className="mini-team">
          {match.teams.home.logo && <img src={match.teams.home.logo} alt="" />}
          <span>{match.teams.home.name}</span>
        </div>
        <div className="mini-team">
          {match.teams.away.logo && <img src={match.teams.away.logo} alt="" />}
          <span>{match.teams.away.name}</span>
        </div>
      </div>
      <div className="live-mini-score">
        {hasScore ? (
          <>
            <span className={live ? 'live' : ''}>{match.goals.home}</span>
            <span className={live ? 'live' : ''}>{match.goals.away}</span>
          </>
        ) : (
          <>
            <span>-</span>
            <span>-</span>
          </>
        )}
      </div>
      <div className="live-mini-actions">
        <a href="https://streamtp10.com/" target="_blank" rel="noopener noreferrer" className="btn-stream-mini" title="Ver">▶</a>
        <button className="btn-remove-mini" onClick={onRemove} title="Quitar">×</button>
      </div>
    </div>
  );
}
