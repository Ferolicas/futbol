'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { FLAGS } from '../lib/leagues';

const today = () => new Date().toISOString().split('T')[0];
const fmtTime = (d) => new Date(d).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const isLive = (s) => ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'].includes(s);
const isFinished = (s) => ['FT', 'AET', 'PEN', 'CANC', 'SUSP', 'PST', 'ABD', 'AWD', 'WO'].includes(s);
const statusText = (s) => ({
  NS: 'Próximo', '1H': '1T', '2H': '2T', HT: 'Entretiempo',
  FT: 'Final', ET: 'Extra', P: 'Penales', AET: 'Extra', PEN: 'Penales',
  SUSP: 'Suspendido', PST: 'Pospuesto', CANC: 'Cancelado',
}[s] || s);

export default function Dashboard() {
  const router = useRouter();
  const [tab, setTab] = useState('partidos');
  const [date, setDate] = useState(today());
  const [fixtures, setFixtures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fromCache, setFromCache] = useState(false);
  const [quota, setQuota] = useState({ used: 0, remaining: 100, limit: 100 });
  const [hidden, setHidden] = useState([]);
  const [analyzed, setAnalyzed] = useState([]);
  const [analyzedOdds, setAnalyzedOdds] = useState({});
  const [analyzedData, setAnalyzedData] = useState({});
  const [standings, setStandings] = useState({});

  const [sortBy, setSortBy] = useState('time');
  const [statusFilter, setStatusFilter] = useState('all');
  const [leagueFilter, setLeagueFilter] = useState('');

  const [selected, setSelected] = useState(new Set());
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState({ current: 0, total: 0 });

  // For Combinada Total - selected match IDs from Combinadas tab
  const [combinadaSelected, setCombinadaSelected] = useState(new Set());

  const loadFixtures = useCallback(async (d) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/fixtures?date=${d}`);
      const data = await res.json();

      if (data.error && !data.fixtures?.length) {
        setError(data.error);
        if (data.quota) setQuota(data.quota);
        return;
      }

      setFixtures(data.fixtures || []);
      setFromCache(data.fromCache || false);
      setHidden(data.hidden || []);
      setAnalyzed(data.analyzed || []);
      setAnalyzedOdds(data.analyzedOdds || {});
      setAnalyzedData(data.analyzedData || {});
      setStandings(data.standings || {});
      if (data.quota) setQuota(data.quota);
      if (data.error) setError(data.error);
    } catch (e) {
      setError(e.message || 'Error de conexión');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadFixtures(today()); }, [loadFixtures]);

  const changeDate = (offset) => {
    const d = new Date(date);
    d.setDate(d.getDate() + offset);
    const nd = d.toISOString().split('T')[0];
    setDate(nd);
    setSelected(new Set());
    setCombinadaSelected(new Set());
    loadFixtures(nd);
  };

  // Filter fixtures
  const visible = fixtures.filter(f => {
    if (hidden.includes(f.fixture.id)) return false;
    const status = f.fixture.status.short;
    if (statusFilter === 'live' && !isLive(status)) return false;
    if (statusFilter === 'upcoming' && status !== 'NS') return false;
    if (statusFilter === 'finished' && !isFinished(status)) return false;
    if (leagueFilter && String(f.league.id) !== leagueFilter) return false;
    return true;
  });

  // Sort
  const sorted = [...visible].sort((a, b) => {
    if (sortBy === 'time') {
      return new Date(a.fixture.date) - new Date(b.fixture.date);
    }
    if (sortBy === 'odds') {
      const oddA = getMinOdd(a, analyzedOdds);
      const oddB = getMinOdd(b, analyzedOdds);
      if (oddA === 0 && oddB === 0) return new Date(a.fixture.date) - new Date(b.fixture.date);
      if (oddA === 0) return 1;
      if (oddB === 0) return -1;
      return oddA - oddB;
    }
    if (sortBy === 'probability') {
      const aAnalyzed = analyzed.includes(a.fixture.id) ? 1 : 0;
      const bAnalyzed = analyzed.includes(b.fixture.id) ? 1 : 0;
      if (aAnalyzed !== bAnalyzed) return bAnalyzed - aAnalyzed;
      // Both analyzed: sort by highest probability in combinada
      const aProb = analyzedData[a.fixture.id]?.combinada?.combinedProbability || 0;
      const bProb = analyzedData[b.fixture.id]?.combinada?.combinedProbability || 0;
      if (aProb !== bProb) return bProb - aProb;
      return new Date(a.fixture.date) - new Date(b.fixture.date);
    }
    return 0;
  });

  // Toggle selection for analysis
  const toggleSelect = (fixtureId) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(fixtureId)) next.delete(fixtureId);
      else next.add(fixtureId);
      return next;
    });
  };

  // Toggle selection for combinada total
  const toggleCombinadaSelect = (fixtureId) => {
    setCombinadaSelected(prev => {
      const next = new Set(prev);
      if (next.has(fixtureId)) next.delete(fixtureId);
      else next.add(fixtureId);
      return next;
    });
  };

  // Analyze selected
  const analyzeSelected = async () => {
    const toAnalyze = fixtures.filter(f => selected.has(f.fixture.id));
    if (toAnalyze.length === 0) return;

    setAnalyzing(true);
    setAnalysisProgress({ current: 0, total: toAnalyze.length });

    try {
      const res = await fetch('/api/analisis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtures: toAnalyze }),
      });
      const data = await res.json();

      if (data.quota) setQuota(data.quota);

      const newAnalyzed = data.analyses?.filter(a => a.success)?.map(a => a.fixtureId) || [];
      setAnalyzed(prev => [...new Set([...prev, ...newAnalyzed])]);
      setSelected(new Set());

      if (toAnalyze.length === 1 && newAnalyzed.length === 1) {
        router.push(`/analisis/${newAnalyzed[0]}`);
      } else {
        // Reload to get updated analyzed data
        loadFixtures(date);
      }
    } catch (e) {
      setError('Error al analizar: ' + e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  // Hide match
  const doHide = async (e, fixtureId) => {
    e.stopPropagation();
    setHidden(prev => [...prev, fixtureId]);
    try {
      await fetch('/api/hide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId }),
      });
    } catch {}
  };

  // Counts
  const liveCount = fixtures.filter(f => !hidden.includes(f.fixture.id) && isLive(f.fixture.status.short)).length;
  const upcomingCount = fixtures.filter(f => !hidden.includes(f.fixture.id) && f.fixture.status.short === 'NS').length;

  // Leagues for filter
  const leagues = {};
  fixtures.filter(f => !hidden.includes(f.fixture.id)).forEach(f => {
    if (!leagues[f.league.id]) {
      leagues[f.league.id] = {
        id: f.league.id,
        name: f.league.name,
        country: f.leagueMeta?.country || f.league.country,
        logo: f.league.logo,
      };
    }
  });

  // Apuesta del día - auto-computed from all analyzed matches
  const apuestaDelDia = useMemo(() => {
    const allBets = [];
    Object.entries(analyzedData).forEach(([fid, data]) => {
      if (!data?.combinada?.selections) return;
      const fixture = fixtures.find(f => f.fixture.id === Number(fid));
      const matchName = fixture
        ? `${fixture.teams.home.name} vs ${fixture.teams.away.name}`
        : `${data.homeTeam || '?'} vs ${data.awayTeam || '?'}`;

      data.combinada.selections.forEach(sel => {
        if (sel.probability >= 80) {
          allBets.push({ ...sel, fixtureId: fid, matchName });
        }
      });
    });

    allBets.sort((a, b) => b.probability - a.probability);
    const topBets = allBets.slice(0, 3);
    if (topBets.length === 0) return null;

    const combinedOdd = topBets.reduce((acc, b) => b.odd ? acc * b.odd : acc, 1);
    const combinedProb = topBets.reduce((acc, b) => acc * (b.probability / 100), 1) * 100;

    return {
      selections: topBets,
      combinedOdd: +combinedOdd.toFixed(2),
      combinedProbability: +combinedProb.toFixed(1),
    };
  }, [analyzedData, fixtures]);

  // Combinada Total computation
  const combinadaTotal = useMemo(() => {
    if (combinadaSelected.size < 2) return null;

    const selections = [];
    let totalOdd = 1;
    let totalProb = 1;

    combinadaSelected.forEach(fid => {
      const data = analyzedData[fid];
      if (!data?.combinada?.selections?.length) return;
      const fixture = fixtures.find(f => f.fixture.id === Number(fid));
      const matchName = fixture
        ? `${fixture.teams.home.name} vs ${fixture.teams.away.name}`
        : `${data.homeTeam || '?'} vs ${data.awayTeam || '?'}`;

      // Take the top selection from each match
      const topSel = data.combinada.selections[0];
      selections.push({
        ...topSel,
        fixtureId: fid,
        matchName,
        matchOdd: data.combinada.combinedOdd,
        matchProb: data.combinada.combinedProbability,
      });
      if (topSel.odd) totalOdd *= topSel.odd;
      totalProb *= (topSel.probability / 100);
    });

    return {
      selections,
      combinedOdd: +totalOdd.toFixed(2),
      combinedProbability: +(totalProb * 100).toFixed(1),
    };
  }, [combinadaSelected, analyzedData, fixtures]);

  // Analyzed fixtures for the Analizados tab
  const analyzedFixtures = fixtures.filter(f => analyzed.includes(f.fixture.id));

  // Combinadas count
  const combinadasCount = Object.keys(analyzedData).filter(
    id => analyzedData[id]?.combinada?.selections?.length > 0
  ).length;

  return (
    <div className="app">
      <div className="container">
        {/* HEADER */}
        <header className="header">
          <h1>Futbol Analysis</h1>

          {/* APUESTA DEL DÍA */}
          {apuestaDelDia && (
            <div className="apuesta-del-dia">
              <div className="apuesta-header">
                <span className="apuesta-icon">{'\u{1F3AF}'}</span>
                <span className="apuesta-title">Apuesta del D&iacute;a</span>
                <span className="apuesta-prob-total">{apuestaDelDia.combinedProbability}%</span>
              </div>
              <div className="apuesta-selections">
                {apuestaDelDia.selections.map((sel, i) => (
                  <div key={i} className="apuesta-sel">
                    <span className="apuesta-match">{sel.matchName}</span>
                    <span className="apuesta-market">{sel.name}</span>
                    <span className="apuesta-prob">{sel.probability}%</span>
                    {sel.odd && <span className="apuesta-odd">{sel.odd.toFixed(2)}</span>}
                  </div>
                ))}
              </div>
              {apuestaDelDia.combinedOdd > 1 && (
                <div className="apuesta-footer">
                  <span>Cuota combinada: <strong>{apuestaDelDia.combinedOdd}</strong></span>
                  <span>Probabilidad: <strong>{apuestaDelDia.combinedProbability}%</strong></span>
                </div>
              )}
            </div>
          )}

          <div className="date-nav">
            <button onClick={() => changeDate(-1)} aria-label="D&iacute;a anterior">{'\u25C0'}</button>
            <div className="date-display">
              {new Date(date + 'T12:00:00').toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' })}
            </div>
            <button onClick={() => changeDate(1)} aria-label="D&iacute;a siguiente">{'\u25B6'}</button>
          </div>
          <button className="btn-reload" onClick={() => loadFixtures(date)} disabled={loading}>
            {loading ? '...' : '\u21BB'}
          </button>
        </header>

        {/* TABS */}
        <div className="tabs-bar">
          {[
            { key: 'partidos', label: 'Partidos', count: visible.length },
            { key: 'analizados', label: 'Analizados', count: analyzed.length },
            { key: 'combinadas', label: 'Combinadas', count: combinadasCount },
            { key: 'combinadaTotal', label: 'Combinada Total', count: combinadaSelected.size },
          ].map(t => (
            <button
              key={t.key}
              className={`tab-btn ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {t.count > 0 && <span className="tab-count">{t.count}</span>}
            </button>
          ))}
        </div>

        {/* FILTERS — only for Partidos tab */}
        {tab === 'partidos' && (
          <div className="filter-bar">
            <div className="chips">
              {[
                { key: 'all', label: 'Todos', count: visible.length },
                { key: 'live', label: 'En Vivo', count: liveCount },
                { key: 'upcoming', label: 'Pr\u00F3ximos', count: upcomingCount },
                { key: 'finished', label: 'Finalizados' },
              ].map(c => (
                <button
                  key={c.key}
                  className={`chip ${statusFilter === c.key ? 'active' : ''}`}
                  onClick={() => setStatusFilter(c.key)}
                >
                  {c.label}
                  {c.count > 0 && <span className="chip-count">{c.count}</span>}
                </button>
              ))}
            </div>
            <div className="filters">
              <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="sort-select">
                <option value="time">Por hora</option>
                <option value="odds">Por cuota</option>
                <option value="probability">Por an&aacute;lisis</option>
              </select>
              <select value={leagueFilter} onChange={e => setLeagueFilter(e.target.value)}>
                <option value="">Todas las ligas</option>
                {Object.values(leagues).sort((a, b) => a.name.localeCompare(b.name)).map(l => (
                  <option key={l.id} value={l.id}>{FLAGS[l.country] || ''} {l.name}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* RATE LIMIT WARNING */}
        {error && fixtures.length > 0 && (
          <div className="warning-banner"><span>{error}</span></div>
        )}

        {/* LOADING */}
        {loading && (
          <div className="loading-skeletons">
            {[1, 2, 3, 4, 5].map(i => <div key={i} className="skeleton-match" />)}
          </div>
        )}

        {/* ERROR (no data) */}
        {!loading && error && fixtures.length === 0 && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => loadFixtures(date)}>Reintentar</button>
          </div>
        )}

        {/* ===== TAB: PARTIDOS ===== */}
        {!loading && tab === 'partidos' && (
          <>
            {sorted.length === 0 && !error && (
              <div className="empty">
                <h3>Sin partidos</h3>
                <p>No hay partidos para esta fecha con los filtros seleccionados</p>
              </div>
            )}
            {sorted.length > 0 && (
              <div className="match-list">
                {sorted.map(match => (
                  <MatchCard
                    key={match.fixture.id}
                    match={match}
                    isAnalyzed={analyzed.includes(match.fixture.id)}
                    isSelected={selected.has(match.fixture.id)}
                    odds={analyzedOdds[match.fixture.id]}
                    standings={standings}
                    onSelect={() => toggleSelect(match.fixture.id)}
                    onHide={(e) => doHide(e, match.fixture.id)}
                    onView={() => router.push(`/analisis/${match.fixture.id}`)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ===== TAB: ANALIZADOS ===== */}
        {!loading && tab === 'analizados' && (
          <>
            {analyzedFixtures.length === 0 ? (
              <div className="empty">
                <h3>Sin partidos analizados</h3>
                <p>Selecciona partidos en la pesta&ntilde;a Partidos y anal&iacute;zalos</p>
              </div>
            ) : (
              <div className="match-list">
                {analyzedFixtures.map(match => (
                  <MatchCard
                    key={match.fixture.id}
                    match={match}
                    isAnalyzed={true}
                    isSelected={false}
                    odds={analyzedOdds[match.fixture.id]}
                    standings={standings}
                    onSelect={() => {}}
                    onHide={(e) => doHide(e, match.fixture.id)}
                    onView={() => router.push(`/analisis/${match.fixture.id}`)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ===== TAB: COMBINADAS ===== */}
        {!loading && tab === 'combinadas' && (
          <>
            {combinadasCount === 0 ? (
              <div className="empty">
                <h3>Sin combinadas</h3>
                <p>Analiza partidos para ver sus combinadas autom&aacute;ticas</p>
              </div>
            ) : (
              <div className="combinadas-list">
                {Object.entries(analyzedData)
                  .filter(([, data]) => data?.combinada?.selections?.length > 0)
                  .map(([fid, data]) => {
                    const fixture = fixtures.find(f => f.fixture.id === Number(fid));
                    const matchName = fixture
                      ? `${fixture.teams.home.name} vs ${fixture.teams.away.name}`
                      : `${data.homeTeam || '?'} vs ${data.awayTeam || '?'}`;
                    const homeLogo = fixture?.teams?.home?.logo || data.homeLogo;
                    const awayLogo = fixture?.teams?.away?.logo || data.awayLogo;
                    const isChecked = combinadaSelected.has(Number(fid));

                    return (
                      <div key={fid} className={`combinada-match-card ${isChecked ? 'selected' : ''}`}>
                        <div className="combinada-match-header">
                          <label className="match-checkbox" onClick={e => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleCombinadaSelect(Number(fid))}
                            />
                            <span className="checkmark" />
                          </label>
                          <div className="combinada-match-teams">
                            <TeamLogo src={homeLogo} name={data.homeTeam} size={20} />
                            <span className="combinada-match-name">{matchName}</span>
                            <TeamLogo src={awayLogo} name={data.awayTeam} size={20} />
                          </div>
                          <button
                            className="btn-view-sm"
                            onClick={() => router.push(`/analisis/${fid}`)}
                          >
                            Ver
                          </button>
                        </div>
                        <div className="combinada-selections-list">
                          {data.combinada.selections.map((sel, i) => (
                            <div key={i} className="combinada-sel-row">
                              <span className="combinada-sel-num">#{i + 1}</span>
                              <span className="combinada-sel-name">{sel.name}</span>
                              <span className="combinada-sel-prob">{sel.probability}%</span>
                              {sel.odd && <span className="combinada-sel-odd">{sel.odd.toFixed(2)}</span>}
                            </div>
                          ))}
                        </div>
                        <div className="combinada-match-footer">
                          <span>Cuota: <strong>{data.combinada.combinedOdd}</strong></span>
                          <span>Prob: <strong className={data.combinada.highRisk ? 'danger' : 'safe'}>
                            {data.combinada.combinedProbability}%
                          </strong></span>
                        </div>
                      </div>
                    );
                  })}

                {combinadaSelected.size >= 2 && (
                  <div className="floating-bar">
                    <button
                      className="btn-analyze"
                      onClick={() => setTab('combinadaTotal')}
                    >
                      Ver Combinada Total ({combinadaSelected.size} partidos)
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ===== TAB: COMBINADA TOTAL ===== */}
        {!loading && tab === 'combinadaTotal' && (
          <>
            {!combinadaTotal ? (
              <div className="empty">
                <h3>Selecciona partidos</h3>
                <p>Ve a la pesta&ntilde;a Combinadas y selecciona al menos 2 partidos para crear una combinada total</p>
              </div>
            ) : (
              <div className="combinada-total-container">
                <div className="combinada-total-card">
                  <div className="combinada-total-header">
                    <h3>Combinada Total &mdash; {combinadaTotal.selections.length} partidos</h3>
                  </div>
                  <div className="combinada-total-selections">
                    {combinadaTotal.selections.map((sel, i) => (
                      <div key={i} className="combinada-total-row">
                        <div className="combinada-total-match">
                          <span className="ct-num">#{i + 1}</span>
                          <span className="ct-match">{sel.matchName}</span>
                        </div>
                        <div className="combinada-total-bet">
                          <span className="ct-market">{sel.name}</span>
                          <span className="ct-prob">{sel.probability}%</span>
                          {sel.odd && <span className="ct-odd">{sel.odd.toFixed(2)}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="combinada-total-summary">
                    <div className="ct-total-row">
                      <span>Cuota combinada total</span>
                      <strong className="ct-total-odd">{combinadaTotal.combinedOdd}</strong>
                    </div>
                    <div className="ct-total-row">
                      <span>Probabilidad combinada</span>
                      <strong className={combinadaTotal.combinedProbability >= 60 ? 'safe' : 'danger'}>
                        {combinadaTotal.combinedProbability}%
                      </strong>
                    </div>
                    {combinadaTotal.combinedProbability < 60 && (
                      <div className="ct-warning">
                        Combinada de riesgo alto &mdash; probabilidad por debajo del 60%
                      </div>
                    )}
                  </div>
                </div>
                <button
                  className="btn-secondary"
                  onClick={() => { setCombinadaSelected(new Set()); setTab('combinadas'); }}
                  style={{ marginTop: 16 }}
                >
                  Limpiar selecci&oacute;n
                </button>
              </div>
            )}
          </>
        )}

        {/* FLOATING ANALYZE BUTTON */}
        {selected.size > 0 && tab === 'partidos' && (
          <div className="floating-bar">
            <button className="btn-analyze" onClick={analyzeSelected} disabled={analyzing}>
              {analyzing
                ? `Analizando... ${analysisProgress.current}/${analysisProgress.total}`
                : `Analizar ${selected.size} partido${selected.size > 1 ? 's' : ''}`
              }
            </button>
          </div>
        )}

        {/* ANALYZING OVERLAY */}
        {analyzing && (
          <div className="analyzing-overlay">
            <div className="analyzing-card">
              <div className="analyzing-spinner" />
              <p>Analizando {selected.size} partido{selected.size > 1 ? 's' : ''}...</p>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: '100%' }} />
              </div>
              <span className="analyzing-note">Esto puede tomar unos segundos</span>
            </div>
          </div>
        )}

        {/* FOOTER */}
        <div className="footer">
          <span>Llamadas: {quota.used}/{quota.limit}</span>
          <span>{fromCache ? 'Cache' : 'API'}</span>
          <span>{sorted.length} partidos</span>
        </div>
      </div>
    </div>
  );
}

// ===================== MATCH CARD =====================

function MatchCard({ match, isAnalyzed, isSelected, odds, standings, onSelect, onHide, onView }) {
  const live = isLive(match.fixture.status.short);
  const finished = isFinished(match.fixture.status.short);
  const hasScore = live || finished;
  const meta = match.leagueMeta || {};
  const flag = FLAGS[meta.country] || '';
  const statusLbl = live ? 'EN VIVO' : finished ? 'FINALIZADO' : 'PR\u00D3XIMO';
  const homePos = standings?.[match.teams.home.id];
  const awayPos = standings?.[match.teams.away.id];

  return (
    <div className={`match-card ${live ? 'live' : ''} ${finished ? 'finished' : ''} ${isSelected ? 'selected' : ''}`}>
      <div className="match-card-left">
        <label className="match-checkbox" onClick={e => e.stopPropagation()}>
          <input type="checkbox" checked={isSelected} onChange={onSelect} />
          <span className="checkmark" />
        </label>
        <div className="match-time-col">
          {live ? (
            <span className="time-live">{match.fixture.status.elapsed}&apos;</span>
          ) : finished ? (
            <span className="time-ft">{statusText(match.fixture.status.short)}</span>
          ) : (
            <span className="time-ns">{fmtTime(match.fixture.date)}</span>
          )}
          <span className={`status-micro ${live ? 'live' : finished ? 'ft' : 'ns'}`}>{statusLbl}</span>
        </div>
      </div>

      <div className="match-card-center">
        <div className="match-league-line">
          {match.league.logo && <img src={match.league.logo} alt="" className="league-micro" />}
          <span>{flag} {match.league.name}</span>
        </div>
        <div className="match-teams-row">
          <div className="team-row">
            <div className="team-with-pos">
              {homePos && <span className="pos-badge">{homePos}{'\u00B0'}</span>}
              <TeamLogo src={match.teams.home.logo} name={match.teams.home.name} />
            </div>
            <span className="team-name">{match.teams.home.name}</span>
          </div>
          <div className="match-score-center">
            {hasScore ? (
              <span className={`score-display ${live ? 'live' : ''}`}>
                {match.goals.home} - {match.goals.away}
              </span>
            ) : (
              <span className="score-display dim">vs</span>
            )}
          </div>
          <div className="team-row right">
            <span className="team-name">{match.teams.away.name}</span>
            <div className="team-with-pos">
              <TeamLogo src={match.teams.away.logo} name={match.teams.away.name} />
              {awayPos && <span className="pos-badge">{awayPos}{'\u00B0'}</span>}
            </div>
          </div>
        </div>
        {odds && (
          <div className="card-odds-row">
            <span className="card-odd">{odds.home?.toFixed(2)}</span>
            <span className="card-odd draw">{odds.draw?.toFixed(2)}</span>
            <span className="card-odd">{odds.away?.toFixed(2)}</span>
          </div>
        )}
      </div>

      <div className="match-card-right">
        {isAnalyzed ? (
          <button className="btn-view-analysis" onClick={onView}>
            <span className="analyzed-badge">ANALIZADO</span>
            Ver
          </button>
        ) : (
          <button className="btn-select" onClick={onSelect}>
            {isSelected ? '\u2713' : 'Analizar'}
          </button>
        )}
        <button className="btn-hide-sm" onClick={onHide} title="Ocultar">{'\u00D7'}</button>
      </div>
    </div>
  );
}

function TeamLogo({ src, name, size = 24 }) {
  const [err, setErr] = useState(false);
  if (!src || err) {
    return (
      <div className="team-logo-fallback" style={{ width: size, height: size, fontSize: size * 0.4 }}>
        {(name || '?').slice(0, 2).toUpperCase()}
      </div>
    );
  }
  return <img src={src} alt={name} width={size} height={size} className="team-crest" onError={() => setErr(true)} />;
}

function getMinOdd(fixture, analyzedOdds) {
  const odds = analyzedOdds?.[fixture.fixture.id];
  if (!odds) return 0;
  return Math.min(odds.home || 99, odds.draw || 99, odds.away || 99);
}
