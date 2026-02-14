'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

const FLAGS = {
  Germany: '🇩🇪', Spain: '🇪🇸', England: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', Italy: '🇮🇹', Turkey: '🇹🇷',
  Colombia: '🇨🇴', Brazil: '🇧🇷', France: '🇫🇷', 'Saudi Arabia': '🇸🇦', Argentina: '🇦🇷', Mexico: '🇲🇽',
};

const today = () => new Date().toISOString().split('T')[0];
const fmtTime = (d) => new Date(d).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const isLive = (s) => ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'].includes(s);
const statusText = (s) => ({ NS: 'Proximo', '1H': '1T', '2H': '2T', HT: 'HT', FT: 'Final', ET: 'Extra', P: 'Pen', AET: 'Extra', PEN: 'Pen', SUSP: 'Susp', PST: 'Post', CANC: 'Canc' }[s] || s);

export default function Home() {
  const [view, setView] = useState('list'); // 'list' or 'analysis'
  const [date, setDate] = useState(today());
  const [matches, setMatches] = useState([]);
  const [hiddenIds, setHiddenIds] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [analyses, setAnalyses] = useState({});
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState({ done: 0, total: 0 });
  const [countryFilter, setCountryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [genderFilter, setGenderFilter] = useState('');
  const [apiCalls, setApiCalls] = useState(0);
  const [fromCache, setFromCache] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const intervalRef = useRef(null);

  useEffect(() => {
    fetch('/api/hide').then(r => r.json()).then(d => setHiddenIds(d.hidden || [])).catch(() => {});
    loadMatches(today());
  }, []);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(refreshLive, 60000);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, date]);

  const loadMatches = useCallback(async (d) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/matches?date=${d}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setMatches(data.matches || []);
      setFromCache(data.fromCache);
      setApiCalls(prev => prev + (data.apiCalls || 0));
      setSelected(new Set());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshLive = useCallback(async () => {
    try {
      const res = await fetch(`/api/live?date=${date}`);
      const data = await res.json();
      if (data.matches) { setMatches(data.matches); setApiCalls(prev => prev + (data.apiCalls || 0)); }
    } catch {}
  }, [date]);

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

  const analyzeBatch = async () => {
    const toAnalyze = filtered.filter(m => selected.has(m.fixture.id));
    if (toAnalyze.length === 0) return;

    setAnalyzing(true);
    setAnalyzeProgress({ done: 0, total: toAnalyze.length });
    setView('analysis');

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
      if (data.error) throw new Error(data.error);

      setAnalyses(prev => ({ ...prev, ...data.results }));
      setApiCalls(prev => prev + (data.apiCalls || 0));
      setAnalyzeProgress({ done: toAnalyze.length, total: toAnalyze.length });
    } catch (e) {
      console.error(e);
    } finally {
      setAnalyzing(false);
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
  const selectedMatches = filtered.filter(m => selected.has(m.fixture.id));

  return (
    <div className="app">
      <div className="container">
        {/* HEADER */}
        <div className="header">
          <div className="header-top">
            <h1>Futbol Analysis</h1>
            <div className="header-badges">
              <span className="badge badge-cache">{fromCache ? 'Cache' : 'API'}</span>
              <span className="badge badge-api">Calls: {apiCalls}</span>
              <span className="badge badge-count">{filtered.length} partidos</span>
            </div>
          </div>
        </div>

        {/* STATS */}
        <div className="stats-bar">
          <div className="stat-pill"><div className="label">Partidos</div><div className="value green">{filtered.length}</div></div>
          <div className="stat-pill"><div className="label">En Vivo</div><div className="value red">{liveCount}</div></div>
          <div className="stat-pill"><div className="label">Seleccionados</div><div className="value blue">{selected.size}</div></div>
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

        {/* VIEW TOGGLE */}
        {view === 'analysis' ? (
          // ================ ANALYSIS VIEW ================
          <div className="analysis-view">
            <div className="analysis-header">
              <div>
                <h2>Analisis de Partidos</h2>
                {analyzing && (
                  <div className="analysis-progress" style={{ marginTop: 6 }}>
                    <div className="progress-bar-bg">
                      <div className="progress-bar-fill" style={{ width: `${analyzeProgress.total ? (analyzeProgress.done / analyzeProgress.total) * 100 : 0}%` }} />
                    </div>
                    <span>Analizando...</span>
                  </div>
                )}
              </div>
              <button className="btn btn-ghost" onClick={() => setView('list')}>Volver a Lista</button>
            </div>

            {analyzing && (
              <div className="loader">
                <div className="spinner-ring" />
                <p>Analizando {selectedMatches.length} partidos... Esto puede tardar unos segundos</p>
              </div>
            )}

            {!analyzing && selectedMatches.map(match => (
              <AnalysisCard key={match.fixture.id} match={match} analysis={analyses[match.fixture.id]} />
            ))}
          </div>
        ) : (
          // ================ LIST VIEW ================
          <>
            {/* TOOLBAR */}
            <div className="toolbar">
              <select value={countryFilter} onChange={e => setCountryFilter(e.target.value)}>
                <option value="">Todos los paises</option>
                {Object.entries(FLAGS).map(([c, f]) => <option key={c} value={c}>{f} {c}</option>)}
              </select>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="">Estado</option>
                <option value="live">En Vivo</option>
                <option value="upcoming">Proximos</option>
                <option value="finished">Finalizados</option>
              </select>
              <select value={genderFilter} onChange={e => setGenderFilter(e.target.value)}>
                <option value="">Genero</option>
                <option value="M">Masculino</option>
                <option value="W">Femenino</option>
              </select>
              <button className="btn btn-primary" onClick={() => loadMatches(date)} disabled={loading}>
                {loading ? 'Cargando...' : 'Cargar'}
              </button>
              <button className={`btn ${autoRefresh ? 'btn-danger' : 'btn-ghost'} btn-sm`} onClick={() => setAutoRefresh(!autoRefresh)}>
                {autoRefresh ? 'Auto ON' : 'Auto OFF'}
              </button>
            </div>

            {/* LOADING */}
            {loading && <div className="loader"><div className="spinner-ring" /><p>Cargando partidos del dia...</p></div>}

            {/* EMPTY */}
            {!loading && filtered.length === 0 && (
              <div className="empty"><h3>Sin partidos</h3><p>No hay partidos para esta fecha con los filtros actuales</p></div>
            )}

            {/* SELECT ALL */}
            {!loading && filtered.length > 0 && (
              <div className="select-all-row">
                <label>
                  <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={selectAll} />
                  Seleccionar todos ({filtered.length})
                </label>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  Click en un partido para seleccionarlo
                </span>
              </div>
            )}

            {/* MATCH LIST */}
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

            {/* FLOATING SELECTION BAR */}
            {selected.size > 0 && (
              <div className="selection-bar">
                <div>
                  <div className="count">{selected.size} seleccionados</div>
                  <div className="api-cost">~{selected.size * 5} API calls</div>
                </div>
                <button className="btn btn-primary btn-lg" onClick={analyzeBatch} disabled={analyzing}>
                  Analizar Seleccion
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
                  Limpiar
                </button>
              </div>
            )}
          </>
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
              {live ? `${match.fixture.status.elapsed || ''}' ${statusText(match.fixture.status.short)}` : fmtTime(match.fixture.date)}
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

// ==================== ANALYSIS CARD ====================
function AnalysisCard({ match, analysis }) {
  const live = isLive(match.fixture.status.short);
  const meta = match.leagueMeta || {};
  const flag = FLAGS[meta.country] || '';
  const hasScore = live || ['FT', 'AET', 'PEN'].includes(match.fixture.status.short);

  if (!analysis || analysis.error) {
    return (
      <div className="analysis-card">
        <div className="analysis-card-header">
          <div className="league">
            {match.league.logo && <img src={match.league.logo} alt="" />}
            <span>{flag} {match.league.name}</span>
          </div>
        </div>
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
          {analysis?.error ? `Error: ${analysis.error}` : 'Cargando...'}
        </div>
      </div>
    );
  }

  const { homeStats, awayStats, h2h, odds, injuries, betterForm } = analysis;

  return (
    <div className="analysis-card">
      {/* Header */}
      <div className="analysis-card-header">
        <div className="league">
          {match.league.logo && <img src={match.league.logo} alt="" />}
          <span>{flag} {match.league.name}</span>
          {meta.gender === 'W' && <span className="gender-tag">Fem</span>}
        </div>
        <span className="time">
          {live ? `${match.fixture.status.elapsed}' ${statusText(match.fixture.status.short)}` : fmtTime(match.fixture.date)}
        </span>
      </div>

      {/* Teams display */}
      <div className="analysis-card-teams">
        <div className="analysis-team">
          {match.teams.home.logo && <img src={match.teams.home.logo} alt="" />}
          <span className="name">{match.teams.home.name}</span>
        </div>
        <div className="analysis-vs">
          {hasScore ? `${match.goals.home} - ${match.goals.away}` : 'VS'}
        </div>
        <div className="analysis-team">
          {match.teams.away.logo && <img src={match.teams.away.logo} alt="" />}
          <span className="name">{match.teams.away.name}</span>
        </div>
      </div>

      {/* Body */}
      <div className="analysis-card-body">
        {/* Stats comparison */}
        <div className="stats-comparison">
          <TeamStats team={match.teams.home} stats={homeStats} isBest={betterForm === 'home'} />
          <TeamStats team={match.teams.away} stats={awayStats} isBest={betterForm === 'away'} />
        </div>

        {/* Extra panels */}
        <div className="extra-panels">
          <H2HPanel h2h={h2h} homeId={match.teams.home.id} homeName={match.teams.home.name} />
          <InjuriesPanel injuries={injuries} homeId={match.teams.home.id} awayId={match.teams.away.id} />
          <OddsPanel odds={odds} />
        </div>
      </div>
    </div>
  );
}

// ==================== TEAM STATS ====================
function TeamStats({ team, stats, isBest }) {
  if (!stats) {
    return (
      <div className="team-stats-panel">
        <div className="team-stats-header">
          {team.logo && <img src={team.logo} alt="" />}
          <div className="info"><div className="team-name">{team.name}</div></div>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Sin datos disponibles</p>
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
        {team.logo && <img src={team.logo} alt="" />}
        <div className="info">
          <div className="team-name">{team.name}</div>
          <div>
            {isBest && <span className="best-badge">Mejor Forma</span>}
            <span className="pos-badge">#{pos}</span>
          </div>
        </div>
      </div>

      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Ultimos 5</div>
      <div className="form-row">
        {form.split('').slice(-5).map((l, i) => <span key={i} className={`form-dot ${l}`}>{l}</span>)}
        {!form && <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>N/A</span>}
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

// ==================== H2H PANEL ====================
function H2HPanel({ h2h, homeId, homeName }) {
  if (!h2h || h2h.length === 0) {
    return <div className="info-panel"><h4>Historial H2H</h4><p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Sin datos</p></div>;
  }

  const asHome = h2h.filter(m => m.teams.home.id === homeId).slice(0, 3);
  const asAway = h2h.filter(m => m.teams.away.id === homeId).slice(0, 3);

  return (
    <div className="info-panel">
      <h4>Historial H2H</h4>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--blue)', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' }}>{homeName} Local</div>
        {asHome.length > 0 ? asHome.map((m, i) => (
          <div key={i} className="h2h-item">
            <span className="date">{new Date(m.fixture.date).toLocaleDateString('es', { day: '2-digit', month: 'short', year: '2-digit' })}</span>
            <span className="result">{m.goals.home} - {m.goals.away}</span>
          </div>
        )) : <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Sin datos</div>}
      </div>
      <div>
        <div style={{ fontSize: '0.7rem', color: 'var(--orange)', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' }}>{homeName} Visitante</div>
        {asAway.length > 0 ? asAway.map((m, i) => (
          <div key={i} className="h2h-item">
            <span className="date">{new Date(m.fixture.date).toLocaleDateString('es', { day: '2-digit', month: 'short', year: '2-digit' })}</span>
            <span className="result">{m.goals.home} - {m.goals.away}</span>
          </div>
        )) : <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Sin datos</div>}
      </div>
    </div>
  );
}

// ==================== INJURIES PANEL ====================
function InjuriesPanel({ injuries, homeId, awayId }) {
  if (!injuries || injuries.length === 0) {
    return <div className="info-panel"><h4>Lesionados / Suspendidos</h4><p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Sin bajas reportadas</p></div>;
  }

  const homeInj = injuries.filter(i => i.team.id === homeId);
  const awayInj = injuries.filter(i => i.team.id === awayId);

  return (
    <div className="info-panel">
      <h4>Lesionados / Suspendidos</h4>
      {homeInj.length > 0 ? (
        <>
          <div style={{ fontSize: '0.7rem', color: 'var(--blue)', fontWeight: 700, marginBottom: 4 }}>LOCAL</div>
          {homeInj.map((inj, i) => (
            <div key={i} className="injury-row"><strong>{inj.player.name}</strong> — {inj.player.reason || 'Lesion'}</div>
          ))}
        </>
      ) : <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6 }}>Local: Sin bajas</div>}

      {awayInj.length > 0 ? (
        <>
          <div style={{ fontSize: '0.7rem', color: 'var(--orange)', fontWeight: 700, marginBottom: 4, marginTop: 8 }}>VISITANTE</div>
          {awayInj.map((inj, i) => (
            <div key={i} className="injury-row"><strong>{inj.player.name}</strong> — {inj.player.reason || 'Lesion'}</div>
          ))}
        </>
      ) : <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 6 }}>Visitante: Sin bajas</div>}
    </div>
  );
}

// ==================== ODDS PANEL ====================
function OddsPanel({ odds }) {
  if (!odds || !odds.bookmakers || odds.bookmakers.length === 0) {
    return <div className="info-panel"><h4>Cuotas</h4><p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>No disponibles</p></div>;
  }

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
