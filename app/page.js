'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

const COUNTRY_FLAGS = {
  Germany: '🇩🇪', Spain: '🇪🇸', England: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', Italy: '🇮🇹',
  Turkey: '🇹🇷', Colombia: '🇨🇴', Brazil: '🇧🇷', France: '🇫🇷',
  'Saudi Arabia': '🇸🇦', Argentina: '🇦🇷', Mexico: '🇲🇽',
};

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function formatTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function isLive(status) {
  return ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'].includes(status);
}

function statusLabel(short) {
  const map = { NS: 'Proximo', '1H': '1er Tiempo', '2H': '2do Tiempo', HT: 'Descanso', FT: 'Finalizado', ET: 'Extra', P: 'Penales', AET: 'Extra', PEN: 'Penales', SUSP: 'Suspendido', PST: 'Pospuesto', CANC: 'Cancelado', ABD: 'Abandonado', AWD: 'Victoria Admin', WO: 'W.O.', INT: 'Interrumpido' };
  return map[short] || short;
}

export default function Home() {
  const [date, setDate] = useState(todayStr());
  const [matches, setMatches] = useState([]);
  const [hiddenIds, setHiddenIds] = useState([]);
  const [analyses, setAnalyses] = useState({});
  const [loading, setLoading] = useState(false);
  const [loadingAnalysis, setLoadingAnalysis] = useState({});
  const [countryFilter, setCountryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [genderFilter, setGenderFilter] = useState('');
  const [apiCalls, setApiCalls] = useState(0);
  const [fromCache, setFromCache] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const intervalRef = useRef(null);

  // Load hidden matches on mount
  useEffect(() => {
    fetch('/api/hide').then(r => r.json()).then(d => setHiddenIds(d.hidden || [])).catch(() => {});
  }, []);

  // Auto-load today's matches on mount
  useEffect(() => { loadMatches(todayStr()); }, []);

  // Auto-refresh interval
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => refreshLive(), 60000);
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
    } catch (e) {
      console.error(e);
      alert('Error: ' + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshLive = useCallback(async () => {
    try {
      const res = await fetch(`/api/live?date=${date}`);
      const data = await res.json();
      if (data.matches) {
        setMatches(data.matches);
        setApiCalls(prev => prev + (data.apiCalls || 0));
      }
    } catch (e) {
      console.error('Live refresh error:', e);
    }
  }, [date]);

  const changeDate = (offset) => {
    const d = new Date(date);
    d.setDate(d.getDate() + offset);
    const newDate = d.toISOString().split('T')[0];
    setDate(newDate);
    loadMatches(newDate);
  };

  const analyzeMatch = async (match) => {
    const id = match.fixture.id;
    setLoadingAnalysis(prev => ({ ...prev, [id]: true }));
    try {
      const params = new URLSearchParams({
        fixtureId: id,
        homeId: match.teams.home.id,
        awayId: match.teams.away.id,
        leagueId: match.league.id,
        season: match.league.season,
        date: date,
      });
      const res = await fetch(`/api/analyze?${params}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setAnalyses(prev => ({ ...prev, [id]: data.analysis }));
      setApiCalls(prev => prev + (data.apiCalls || 0));
    } catch (e) {
      console.error(e);
      alert('Error al analizar: ' + e.message);
    } finally {
      setLoadingAnalysis(prev => ({ ...prev, [id]: false }));
    }
  };

  const doHide = async (fixtureId) => {
    setHiddenIds(prev => [...prev, fixtureId]);
    try {
      await fetch('/api/hide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId }),
      });
    } catch {}
  };

  // Filter matches
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
  const analyzedCount = Object.keys(analyses).length;

  return (
    <div className="container">
      {/* Header */}
      <div className="header">
        <h1>Futbol Analysis</h1>
        <div className="header-info">
          <span className="badge badge-blue">Cache Sanity: {fromCache ? 'SI' : 'API'}</span>
          <span className="badge badge-red">API Calls: {apiCalls}</span>
          <span className="badge badge-green">{filtered.length} partidos</span>
        </div>
      </div>

      {/* Stats */}
      <div className="stats-grid">
        <div className="stat-card"><h3>Partidos</h3><div className="number">{filtered.length}</div></div>
        <div className="stat-card"><h3>En Vivo</h3><div className="number" style={{ color: liveCount > 0 ? '#e74c3c' : undefined }}>{liveCount}</div></div>
        <div className="stat-card"><h3>Analizados</h3><div className="number" style={{ color: '#3498db' }}>{analyzedCount}</div></div>
        <div className="stat-card"><h3>Ocultos</h3><div className="number" style={{ color: '#8899a6' }}>{hiddenIds.length}</div></div>
      </div>

      {/* Date navigation */}
      <div className="date-nav">
        <button onClick={() => changeDate(-1)}>&#9664;</button>
        <span>{new Date(date + 'T12:00:00').toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
        <button onClick={() => changeDate(1)}>&#9654;</button>
      </div>

      {/* Filters */}
      <div className="filters">
        <select value={countryFilter} onChange={e => setCountryFilter(e.target.value)}>
          <option value="">Todos los paises</option>
          {Object.entries(COUNTRY_FLAGS).map(([c, flag]) => (
            <option key={c} value={c}>{flag} {c}</option>
          ))}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">Todos</option>
          <option value="live">En Vivo</option>
          <option value="upcoming">Proximos</option>
          <option value="finished">Finalizados</option>
        </select>
        <select value={genderFilter} onChange={e => setGenderFilter(e.target.value)}>
          <option value="">M y F</option>
          <option value="M">Masculino</option>
          <option value="W">Femenino</option>
        </select>
        <button className="btn btn-primary" onClick={() => loadMatches(date)} disabled={loading}>
          {loading ? 'Cargando...' : 'Cargar'}
        </button>
        <button
          className={`btn ${autoRefresh ? 'btn-danger' : 'btn-outline'}`}
          onClick={() => setAutoRefresh(!autoRefresh)}
        >
          {autoRefresh ? 'Auto: ON' : 'Auto: OFF'}
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="loading">
          <div className="spinner" />
          <p>Cargando partidos...</p>
        </div>
      )}

      {/* Matches */}
      {!loading && filtered.length === 0 && (
        <div className="empty-state">
          No hay partidos para esta fecha
          <small>Intenta otra fecha o revisa los filtros</small>
        </div>
      )}

      <div className="matches-container">
        {filtered.map(match => (
          <MatchCard
            key={match.fixture.id}
            match={match}
            analysis={analyses[match.fixture.id]}
            isAnalyzing={loadingAnalysis[match.fixture.id]}
            onAnalyze={() => analyzeMatch(match)}
            onHide={() => doHide(match.fixture.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ==================== MATCH CARD ====================
function MatchCard({ match, analysis, isAnalyzing, onAnalyze, onHide }) {
  const [showDetails, setShowDetails] = useState(false);
  const live = isLive(match.fixture.status.short);
  const meta = match.leagueMeta || {};
  const flag = COUNTRY_FLAGS[meta.country] || '';

  return (
    <div className={`match-card ${live ? 'live' : ''} ${analysis ? 'analyzed' : ''}`}>
      {/* Header */}
      <div className="match-header">
        <div className="league-info">
          {match.league.logo && <img src={match.league.logo} alt="" />}
          <span>{flag} {match.league.name}</span>
          {meta.gender === 'W' && <span className="gender-badge">FEM</span>}
        </div>
        <span className={`match-time ${live ? 'live' : ''}`}>
          {live ? `${match.fixture.status.elapsed || ''}' ${statusLabel(match.fixture.status.short)}` : formatTime(match.fixture.date)}
        </span>
      </div>

      {/* Teams */}
      <div className="teams-row">
        <div className="team">
          {match.teams.home.logo && <img src={match.teams.home.logo} alt="" />}
          <span className="team-name">{match.teams.home.name}</span>
        </div>
        <div className="vs">
          {(live || match.fixture.status.short === 'FT' || match.fixture.status.short === 'AET' || match.fixture.status.short === 'PEN')
            ? <span className="score">{match.goals.home} - {match.goals.away}</span>
            : 'VS'}
        </div>
        <div className="team away">
          {match.teams.away.logo && <img src={match.teams.away.logo} alt="" />}
          <span className="team-name">{match.teams.away.name}</span>
        </div>
      </div>

      {/* Actions */}
      <div className="match-actions">
        <button
          className="btn btn-blue"
          onClick={() => { if (!analysis) onAnalyze(); setShowDetails(!showDetails); }}
          disabled={isAnalyzing}
        >
          {isAnalyzing ? 'Analizando...' : analysis ? (showDetails ? 'Ocultar' : 'Ver Analisis') : 'Analizar'}
        </button>
        <button className="btn btn-danger btn-sm" onClick={onHide}>X</button>
      </div>

      {/* Details */}
      {showDetails && analysis && (
        <div className="details-panel">
          <MatchDetails match={match} analysis={analysis} />
        </div>
      )}
    </div>
  );
}

// ==================== MATCH DETAILS ====================
function MatchDetails({ match, analysis }) {
  const { homeStats, awayStats, h2h, odds, injuries, betterForm } = analysis;

  return (
    <>
      <div className="details-grid">
        <TeamDetail team={match.teams.home} stats={homeStats} isBest={betterForm === 'home'} />
        <TeamDetail team={match.teams.away} stats={awayStats} isBest={betterForm === 'away'} />
      </div>
      <div className="extra-details">
        <H2HSection h2h={h2h} homeId={match.teams.home.id} homeName={match.teams.home.name} awayName={match.teams.away.name} />
        <InjuriesSection injuries={injuries} homeId={match.teams.home.id} awayId={match.teams.away.id} />
        <OddsSection odds={odds} />
      </div>
    </>
  );
}

// ==================== TEAM DETAIL ====================
function TeamDetail({ team, stats, isBest }) {
  if (!stats) {
    return (
      <div className="team-detail">
        <div className="team-detail-header">
          {team.logo && <img src={team.logo} alt="" />}
          <div><div className="name">{team.name}</div></div>
        </div>
        <p style={{ color: '#8899a6', fontSize: '0.85rem' }}>Estadisticas no disponibles</p>
      </div>
    );
  }

  const pos = stats.league?.standings?.[0]?.rank || 'N/A';
  const form = stats.form || '';
  const played = stats.fixtures?.played?.total || 0;
  const wins = stats.fixtures?.wins?.total || 0;
  const draws = stats.fixtures?.draws?.total || 0;
  const losses = stats.fixtures?.loses?.total || 0;
  const gf = stats.goals?.for?.total?.total || 0;
  const ga = stats.goals?.against?.total?.total || 0;
  const avgGoals = played > 0 ? (gf / played).toFixed(2) : '0.00';
  const penMissed = stats.penalty?.missed?.total || 0;

  return (
    <div className="team-detail">
      <div className="team-detail-header">
        {team.logo && <img src={team.logo} alt="" />}
        <div>
          <div className="name">{team.name}</div>
          {isBest && <span className="best-form-badge">MEJOR FORMA</span>}
          <span className="position-badge">#{pos}</span>
        </div>
      </div>

      <div style={{ fontSize: '0.8rem', color: '#8899a6', marginBottom: 4 }}>Ultimos 5:</div>
      <div className="form-display">
        {form.split('').slice(-5).map((l, i) => (
          <span key={i} className={`form-letter ${l}`}>{l}</span>
        ))}
        {!form && <span style={{ color: '#556', fontSize: '0.8rem' }}>N/A</span>}
      </div>

      <div className="stats-list">
        <div className="stat-item"><span className="stat-label">PJ</span><span className="stat-value">{played}</span></div>
        <div className="stat-item"><span className="stat-label">V</span><span className="stat-value">{wins}</span></div>
        <div className="stat-item"><span className="stat-label">E</span><span className="stat-value">{draws}</span></div>
        <div className="stat-item"><span className="stat-label">D</span><span className="stat-value">{losses}</span></div>
        <div className="stat-item"><span className="stat-label">Goles/P</span><span className="stat-value">{avgGoals}</span></div>
        <div className="stat-item"><span className="stat-label">GF</span><span className="stat-value">{gf}</span></div>
        <div className="stat-item"><span className="stat-label">GC</span><span className="stat-value">{ga}</span></div>
        <div className="stat-item"><span className="stat-label">Pen. Fall.</span><span className="stat-value">{penMissed}</span></div>
      </div>
    </div>
  );
}

// ==================== H2H ====================
function H2HSection({ h2h, homeId, homeName, awayName }) {
  if (!h2h || h2h.length === 0) {
    return (
      <div className="detail-box">
        <h4>Historial H2H</h4>
        <p style={{ color: '#8899a6', fontSize: '0.85rem' }}>Sin datos</p>
      </div>
    );
  }

  const asHome = h2h.filter(m => m.teams.home.id === homeId).slice(0, 3);
  const asAway = h2h.filter(m => m.teams.away.id === homeId).slice(0, 3);

  return (
    <div className="detail-box">
      <h4>Historial H2H</h4>
      <div style={{ marginBottom: 8 }}>
        <strong style={{ fontSize: '0.8rem', color: '#3498db' }}>{homeName} como Local (ult. 3):</strong>
        {asHome.length > 0 ? asHome.map((m, i) => (
          <div key={i} className="h2h-row">
            <span>{new Date(m.fixture.date).toLocaleDateString('es')}</span>
            <strong>{m.goals.home} - {m.goals.away}</strong>
          </div>
        )) : <p style={{ color: '#556', fontSize: '0.8rem' }}>Sin datos</p>}
      </div>
      <div>
        <strong style={{ fontSize: '0.8rem', color: '#e67e22' }}>{homeName} como Visitante (ult. 3):</strong>
        {asAway.length > 0 ? asAway.map((m, i) => (
          <div key={i} className="h2h-row">
            <span>{new Date(m.fixture.date).toLocaleDateString('es')}</span>
            <strong>{m.goals.home} - {m.goals.away}</strong>
          </div>
        )) : <p style={{ color: '#556', fontSize: '0.8rem' }}>Sin datos</p>}
      </div>
    </div>
  );
}

// ==================== INJURIES ====================
function InjuriesSection({ injuries, homeId, awayId }) {
  if (!injuries || injuries.length === 0) {
    return (
      <div className="detail-box">
        <h4>Lesionados / Suspendidos</h4>
        <p style={{ color: '#8899a6', fontSize: '0.85rem' }}>Sin bajas reportadas</p>
      </div>
    );
  }

  const homeInj = injuries.filter(i => i.team.id === homeId);
  const awayInj = injuries.filter(i => i.team.id === awayId);

  return (
    <div className="detail-box">
      <h4>Lesionados / Suspendidos</h4>
      {homeInj.length > 0 ? (
        <>
          <strong style={{ fontSize: '0.75rem', color: '#3498db' }}>Local:</strong>
          {homeInj.map((inj, i) => (
            <div key={i} className="injury-item">{inj.player.name} - {inj.player.reason || 'Lesion'}</div>
          ))}
        </>
      ) : <p style={{ fontSize: '0.8rem', color: '#556' }}>Local: Sin bajas</p>}

      <div style={{ marginTop: 8 }}>
        {awayInj.length > 0 ? (
          <>
            <strong style={{ fontSize: '0.75rem', color: '#e67e22' }}>Visitante:</strong>
            {awayInj.map((inj, i) => (
              <div key={i} className="injury-item">{inj.player.name} - {inj.player.reason || 'Lesion'}</div>
            ))}
          </>
        ) : <p style={{ fontSize: '0.8rem', color: '#556' }}>Visitante: Sin bajas</p>}
      </div>
    </div>
  );
}

// ==================== ODDS ====================
function OddsSection({ odds }) {
  if (!odds || !odds.bookmakers || odds.bookmakers.length === 0) {
    return (
      <div className="detail-box">
        <h4>Cuotas de Apuestas</h4>
        <p style={{ color: '#8899a6', fontSize: '0.85rem' }}>No disponibles</p>
      </div>
    );
  }

  const mainBet = odds.bookmakers[0]?.bets?.find(b => b.name === 'Match Winner');
  if (!mainBet) {
    return (
      <div className="detail-box">
        <h4>Cuotas de Apuestas</h4>
        <p style={{ color: '#8899a6', fontSize: '0.85rem' }}>No disponibles</p>
      </div>
    );
  }

  const home = mainBet.values.find(v => v.value === 'Home')?.odd || '-';
  const draw = mainBet.values.find(v => v.value === 'Draw')?.odd || '-';
  const away = mainBet.values.find(v => v.value === 'Away')?.odd || '-';

  return (
    <div className="detail-box">
      <h4>Cuotas de Apuestas</h4>
      <div className="odds-row">
        <div className="odd-item"><div className="odd-label">Local</div><div className="odd-value">{home}</div></div>
        <div className="odd-item"><div className="odd-label">Empate</div><div className="odd-value">{draw}</div></div>
        <div className="odd-item"><div className="odd-label">Visitante</div><div className="odd-value">{away}</div></div>
      </div>
    </div>
  );
}
