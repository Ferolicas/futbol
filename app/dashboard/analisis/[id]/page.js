'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { computeAllProbabilities } from '../../../../lib/calculations';
import { buildCombinada } from '../../../../lib/combinada';
import { selectBookmakerOdds, BOOKMAKER_LOGOS, TIMEZONE_TO_COUNTRY, COUNTRY_BOOKMAKERS } from '../../../../lib/bookmakers';
import { usePusherEvent } from '../../../../lib/use-pusher';

function detectCountry() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TIMEZONE_TO_COUNTRY[tz] || 'default';
  } catch { return 'default'; }
}

const cap = (v) => Math.min(95, v);
const fmtTime = (d) => new Date(d).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const fmtDate = (d) => new Date(d).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShortDate = (d) => new Date(d).toLocaleDateString('es', { day: '2-digit', month: 'short' });
const statusLabel = (s) => ({
  NS: 'PRÓXIMO', '1H': 'EN VIVO — 1T', '2H': 'EN VIVO — 2T', HT: 'EN VIVO — Entretiempo',
  FT: 'FINALIZADO', ET: 'EN VIVO — Extra', P: 'EN VIVO — Penales',
  AET: 'FINALIZADO', PEN: 'FINALIZADO', SUSP: 'SUSPENDIDO', PST: 'POSPUESTO', CANC: 'CANCELADO',
}[s] || s);
const isLiveStatus = (s) => ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'].includes(s);

export default function AnalisisPage() {
  const params = useParams();
  const router = useRouter();
  const fixtureId = params.id;

  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [quota, setQuota] = useState(null);
  const [probabilities, setProbabilities] = useState(null);
  const [combinada, setCombinada] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  const [refreshingLineups, setRefreshingLineups] = useState(false);
  const [refreshingInjuries, setRefreshingInjuries] = useState(false);
  const [userCountry, setUserCountry] = useState('default');
  const [liveStats, setLiveStats] = useState(null);

  useEffect(() => { setUserCountry(detectCountry()); }, []);

  const toggleSection = (key) => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));

  const loadAnalysis = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = new Date();
      const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const res = await fetch(`/api/match/${fixtureId}?date=${localDate}`);
      const data = await res.json();
      if (data.error) { setError(data.error); return; }

      setAnalysis(data.analysis);
      if (data.quota) setQuota(data.quota);

      // Use server-computed probabilities if available (more reliable than recomputing from cached raw data)
      const probs = data.analysis.calculatedProbabilities || computeAllProbabilities(data.analysis);
      setProbabilities(probs);
      // Use server-computed combinada if available
      const teamNames = { home: data.analysis.homeTeam, away: data.analysis.awayTeam };
      setCombinada(data.analysis.combinada || buildCombinada(probs, data.analysis.odds, data.analysis.playerHighlights, teamNames));
    } catch (e) {
      setError(e.message || 'Error loading analysis');
    } finally {
      setLoading(false);
    }
  }, [fixtureId]);

  useEffect(() => { loadAnalysis(); }, [loadAnalysis]);

  // On mount: trigger forced live refresh (runs live + corners crons on server),
  // then apply fresh data. This ensures the match detail always shows real-time status.
  useEffect(() => {
    if (!analysis) return;

    const loadStats = async () => {
      try {
        // Force-refresh: triggers crons on the server, returns all live data
        const refreshRes = await fetch('/api/refresh-live', { method: 'POST' });
        const refreshData = await refreshRes.json();
        if (refreshData.liveStats && refreshData.liveStats[fixtureId]) {
          const matchStats = refreshData.liveStats[fixtureId];
          setLiveStats(matchStats);
          if (matchStats.status) {
            setAnalysis(prev => prev ? ({
              ...prev,
              status: matchStats.status,
              goals: matchStats.goals || prev.goals,
            }) : prev);
          }
          return; // Got data from forced refresh
        }

        // Fallback: read from live-poll (in case refresh-live was rate-limited)
        const res = await fetch(`/api/live-poll?fixtureId=${fixtureId}`);
        const data = await res.json();
        const matchStats = data.liveStats?.find(s =>
          Number(s.fixtureId) === Number(fixtureId)
        );
        if (matchStats) {
          setLiveStats(matchStats);
          if (matchStats.status) {
            setAnalysis(prev => prev ? ({
              ...prev,
              status: matchStats.status,
              goals: matchStats.goals || prev.goals,
            }) : prev);
          }
        }
      } catch {}
    };

    loadStats();
  }, [fixtureId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Real-time updates via Pusher (replaces 30s polling)
  usePusherEvent('live-scores', 'update', useCallback((data) => {
    if (!data?.matches) return;
    const matchUpdate = data.matches.find(m => Number(m.fixtureId) === Number(fixtureId));
    if (!matchUpdate) return;

    setLiveStats(prev => ({
      ...prev,
      ...matchUpdate,
    }));
    if (matchUpdate.status) {
      setAnalysis(prev => prev ? ({
        ...prev,
        status: matchUpdate.status,
        goals: matchUpdate.goals || prev.goals,
      }) : prev);
    }
  }, [fixtureId]));

  // Real-time corners updates (every 30 min from live-corners cron)
  usePusherEvent('live-scores', 'corners-update', useCallback((data) => {
    if (!data?.matches) return;
    const cornerUpdate = data.matches.find(m => Number(m.fixtureId) === Number(fixtureId));
    if (!cornerUpdate) return;

    setLiveStats(prev => ({
      ...prev,
      corners: cornerUpdate.corners,
    }));
  }, [fixtureId]));

  const [lineupsError, setLineupsError] = useState('');

  const doRefreshLineups = async () => {
    setRefreshingLineups(true);
    setLineupsError('');
    try {
      const res = await fetch(`/api/match/${fixtureId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh-lineups' }),
      });
      const data = await res.json();
      if (data.error) {
        setLineupsError(data.error);
      } else if (data.lineups) {
        setAnalysis(prev => ({ ...prev, lineups: data.lineups }));
        if (!data.lineups.available) {
          setLineupsError('Alineaciones aún no disponibles en la API');
        }
      }
      if (data.quota) setQuota(data.quota);
    } catch (e) {
      setLineupsError('Error de conexión al actualizar alineaciones');
    } finally { setRefreshingLineups(false); }
  };

  const doRefreshInjuries = async () => {
    setRefreshingInjuries(true);
    try {
      const res = await fetch(`/api/match/${fixtureId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh-injuries' }),
      });
      const data = await res.json();
      if (data.injuries) setAnalysis(prev => ({ ...prev, injuries: data.injuries }));
      if (data.quota) setQuota(data.quota);
    } catch {} finally { setRefreshingInjuries(false); }
  };

  if (loading) {
    return (
      <div className="analysis-page"><div className="analysis-container">
        <div className="analysis-loading">
          <div className="skeleton-header" /><div className="skeleton-block" />
          <div className="skeleton-block short" /><div className="skeleton-block" />
        </div>
      </div></div>
    );
  }

  if (error) {
    return (
      <div className="analysis-page"><div className="analysis-container">
        <button className="back-btn" onClick={() => router.push('/dashboard')}>&#9664; Volver</button>
        <div className="analysis-error">
          <h3>Error</h3><p>{error}</p>
          <button className="btn-primary" onClick={loadAnalysis}>Reintentar</button>
        </div>
      </div></div>
    );
  }

  if (!analysis) return null;
  const a = analysis;
  const p = probabilities;
  const c = combinada;
  const statusShort = a.status?.short || 'NS';
  const live = isLiveStatus(statusShort);

  return (
    <div className="analysis-page">
      <div className="analysis-container">
        {/* TOP BAR */}
        <div className="analysis-top-bar">
          <button className="back-btn" onClick={() => router.push('/dashboard')}>&#9664; Volver</button>
          {quota && <span className="quota-badge">Llamadas usadas hoy: {quota.used}/{quota.limit}</span>}
        </div>

        {/* ===== SECCIÓN 1 — CABECERA ===== */}
        <div className="match-header-card">
          <div className="match-header-league">
            {a.leagueLogo && <img src={a.leagueLogo} alt="" className="league-icon" />}
            <span>{a.league}</span>
          </div>
          <div className={`match-header-status ${live ? 'live' : ''}`}>
            {statusLabel(statusShort)}
          </div>
          <div className="match-header-teams">
            <div className="header-team">
              {a.homePosition && <span className="pos-badge-lg">{a.homePosition}°</span>}
              {a.calculatedProbabilities?.winner?.home != null && (
                <span className="prob-badge-lg">{cap(a.calculatedProbabilities.winner.home)}%</span>
              )}
              <TeamLogo src={a.homeLogo} name={a.homeTeam} size={64} />
              <span className="header-team-name">{a.homeTeam}</span>
            </div>
            <div className="header-vs">
              {a.goals && (a.goals.home !== null) ? (
                <span className={`header-score ${live ? 'live' : ''}`}>{a.goals.home} - {a.goals.away}</span>
              ) : (
                <span className="header-time">{fmtTime(a.kickoff)}</span>
              )}
              <span className="header-date">{fmtDate(a.kickoff)}</span>
              {(() => {
                // Show aggregate score for two-legged ties
                const round = a.leagueRound || '';
                const is2ndLeg = /2nd leg/i.test(round);
                const is1stLeg = /1st leg/i.test(round);
                if (!is2ndLeg && !is1stLeg) return null;
                // Find the other leg from H2H (same teams, same season)
                const otherLeg = (a.h2h || []).find(h => {
                  const hRound = h.league?.round || '';
                  if (is2ndLeg) return /1st leg/i.test(hRound);
                  return /2nd leg/i.test(hRound);
                });
                if (!otherLeg) return null;
                const legGoals = a.goals || {};
                const otherGoals = otherLeg.goals || {};
                // Calculate aggregate from perspective of current home team
                const curHomeIsLeg1Home = is1stLeg;
                let aggHome, aggAway;
                if (is2ndLeg) {
                  // Current match is 2nd leg
                  // Other leg (1st): check if current home was home or away in 1st leg
                  const wasHomeIn1st = otherLeg.teams?.home?.id === a.homeId;
                  aggHome = (legGoals.home ?? 0) + (wasHomeIn1st ? (otherGoals.home ?? 0) : (otherGoals.away ?? 0));
                  aggAway = (legGoals.away ?? 0) + (wasHomeIn1st ? (otherGoals.away ?? 0) : (otherGoals.home ?? 0));
                } else {
                  // Current match is 1st leg
                  const wasHomeIn2nd = otherLeg.teams?.home?.id === a.homeId;
                  aggHome = (legGoals.home ?? 0) + (wasHomeIn2nd ? (otherGoals.home ?? 0) : (otherGoals.away ?? 0));
                  aggAway = (legGoals.away ?? 0) + (wasHomeIn2nd ? (otherGoals.away ?? 0) : (otherGoals.home ?? 0));
                }
                return (
                  <span className="header-aggregate">
                    Global: {aggHome} - {aggAway}
                    {is1stLeg && <small> (Ida)</small>}
                    {is2ndLeg && <small> (Vuelta)</small>}
                  </span>
                );
              })()}
            </div>
            <div className="header-team">
              {a.awayPosition && <span className="pos-badge-lg">{a.awayPosition}°</span>}
              {a.calculatedProbabilities?.winner?.away != null && (
                <span className="prob-badge-lg">{cap(a.calculatedProbabilities.winner.away)}%</span>
              )}
              <TeamLogo src={a.awayLogo} name={a.awayTeam} size={64} />
              <span className="header-team-name">{a.awayTeam}</span>
            </div>
          </div>
          {a.odds?.matchWinner && (
            <OddsWithBookmaker odds={a.odds} allBookmakerOdds={a.odds?.allBookmakerOdds} userCountry={userCountry} />
          )}
        </div>

        {/* ===== LIVE STATS ===== */}
        {liveStats && (
          <div className="section-card live-section-card">
            <div className="section-header">
              <span className="section-icon">&#9889;</span>
              <span className="section-title">
                {live ? 'En Vivo' : 'Estadisticas del Partido'}
              </span>
            </div>
            <div className="live-detail-grid">
              {/* Stats table */}
              <div className="live-stats-table">
                <div className="lst-header">
                  <span className="lst-team-name">{a.homeTeam}</span>
                  <span className="lst-label">Stat</span>
                  <span className="lst-team-name">{a.awayTeam}</span>
                </div>
                <div className="lst-row">
                  <span className="lst-val">{a.goals?.home ?? liveStats.goals?.home ?? 0}</span>
                  <span className="lst-label">Goles</span>
                  <span className="lst-val">{a.goals?.away ?? liveStats.goals?.away ?? 0}</span>
                </div>
                {liveStats.corners && (
                  <div className="lst-row">
                    <span className="lst-val">{liveStats.corners.home}</span>
                    <span className="lst-label">Corners</span>
                    <span className="lst-val">{liveStats.corners.away}</span>
                  </div>
                )}
                {liveStats.yellowCards && (
                  <div className="lst-row">
                    <span className="lst-val"><span className="yellow-card-sm" /> {liveStats.yellowCards.home}</span>
                    <span className="lst-label">Amarillas</span>
                    <span className="lst-val">{liveStats.yellowCards.away} <span className="yellow-card-sm" /></span>
                  </div>
                )}
                {liveStats.redCards && (liveStats.redCards.home > 0 || liveStats.redCards.away > 0) && (
                  <div className="lst-row">
                    <span className="lst-val"><span className="red-card-sm" /> {liveStats.redCards.home}</span>
                    <span className="lst-label">Rojas</span>
                    <span className="lst-val">{liveStats.redCards.away} <span className="red-card-sm" /></span>
                  </div>
                )}
              </div>

              {/* Goal scorers */}
              {liveStats.goalScorers?.length > 0 && (
                <div className="live-scorers-detail">
                  <h4 className="live-section-title">Goles</h4>
                  {liveStats.goalScorers.map((g, i) => (
                    <div key={i} className={`live-scorer ${g.teamId === a.homeId ? 'home' : 'away'} ${g.type === 'Own Goal' ? 'og' : ''}`}>
                      <span className="scorer-min">{g.minute}{g.extra ? `+${g.extra}` : ''}&apos;</span>
                      <span className="scorer-type">
                        {g.type === 'Penalty' ? '(P)' : g.type === 'Own Goal' ? '(AG)' : ''}
                      </span>
                      <span className="scorer-name">{g.player}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Missed penalties */}
              {liveStats.missedPenalties?.length > 0 && (
                <div className="live-scorers-detail">
                  <h4 className="live-section-title">Penales fallados</h4>
                  {liveStats.missedPenalties.map((p, i) => (
                    <div key={i} className={`live-scorer missed ${p.teamId === a.homeId ? 'home' : 'away'}`}>
                      <span className="scorer-min">{p.minute}{p.extra ? `+${p.extra}` : ''}&apos;</span>
                      <span className="scorer-name">{p.player}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Card events */}
              {liveStats.cardEvents?.length > 0 && (
                <div className="live-scorers-detail">
                  <h4 className="live-section-title">Tarjetas</h4>
                  {liveStats.cardEvents.map((c, i) => (
                    <div key={i} className={`live-scorer ${c.teamId === a.homeId ? 'home' : 'away'}`}>
                      <span className="scorer-min">{c.minute}&apos;</span>
                      <span className="scorer-type">
                        {c.type === 'Yellow Card' ? <span className="yellow-card-sm" /> :
                         c.type === 'Red Card' ? <span className="red-card-sm" /> :
                         <><span className="yellow-card-sm" /><span className="red-card-sm" /></>}
                      </span>
                      <span className="scorer-name">{c.player}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ===== SECCIÓN 2 — ALINEACIONES ===== */}
        <Section title="Alineación Titular" icon="XI" sectionKey="lineups" collapsed={collapsed} toggle={toggleSection}>
          {a.lineups?.available ? (
            <div className="lineups-grid">
              {a.lineups.data.map((team, idx) => (
                <div key={idx} className="lineup-team">
                  <div className="lineup-header">
                    <TeamLogo src={team.team?.logo} name={team.team?.name} size={24} />
                    <span className="lineup-team-name">{team.team?.name}</span>
                    <span className="formation-badge">{team.formation}</span>
                  </div>
                  <div className="lineup-coach">DT: {team.coach?.name || 'N/A'}</div>
                  <div className="lineup-list">
                    <h5>Titulares</h5>
                    {team.startXI?.map((pl, i) => (
                      <div key={i} className="lineup-player">
                        <span className="player-number">{pl.player?.number}</span>
                        <span className="player-name">{pl.player?.name}</span>
                        <span className="player-pos">{pl.player?.pos}</span>
                      </div>
                    ))}
                  </div>
                  <div className="lineup-list subs">
                    <h5>Suplentes</h5>
                    {team.substitutes?.map((pl, i) => (
                      <div key={i} className="lineup-player sub">
                        <span className="player-number">{pl.player?.number}</span>
                        <span className="player-name">{pl.player?.name}</span>
                        <span className="player-pos">{pl.player?.pos}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="no-data-section">
              <span className="warning-icon">&#9888;</span>
              <p>Alineaciones no disponibles aún</p>
              <button className="btn-secondary" onClick={doRefreshLineups} disabled={refreshingLineups}>
                {refreshingLineups ? 'Actualizando...' : 'Actualizar alineaciones'}
              </button>
              {lineupsError && <p style={{ color: '#ef4444', fontSize: '0.85rem', marginTop: '0.5rem' }}>{lineupsError}</p>}
            </div>
          )}
        </Section>

        {/* ===== SECCIÓN 3 — BAJAS EN EL TITULAR HABITUAL ===== */}
        <Section title="Bajas en el titular habitual" icon="&#128681;" sectionKey="injuries" collapsed={collapsed} toggle={toggleSection}>
          <BajasSection
            filteredInjuries={a.filteredInjuries}
            allInjuries={a.injuries}
            homeUsualXI={a.homeUsualXI}
            awayUsualXI={a.awayUsualXI}
            homeTeam={a.homeTeam}
            awayTeam={a.awayTeam}
            onRefresh={doRefreshInjuries}
            refreshing={refreshingInjuries}
          />
        </Section>

        {/* ===== SECCIÓN 4 — ÚLTIMOS 5 ===== */}
        {p && (
          <Section title="Últimos 5 partidos" icon="5" sectionKey="last5" collapsed={collapsed} toggle={toggleSection}>
            <div className="last5-grid">
              <Last5Table team={a.homeTeam} logo={a.homeLogo} teamId={a.homeId} form={p.homeForm} lastFive={a.homeLastFive} />
              <Last5Table team={a.awayTeam} logo={a.awayLogo} teamId={a.awayId} form={p.awayForm} lastFive={a.awayLastFive} />
            </div>
          </Section>
        )}

        {/* ===== SECCIÓN 5 — H2H ===== */}
        {p && (
          <Section title="Historial H2H" icon="VS" sectionKey="h2h" collapsed={collapsed} toggle={toggleSection}>
            <H2HSection h2h={a.h2h} homeTeam={a.homeTeam} awayTeam={a.awayTeam} homeId={a.homeId} summary={p.h2hSummary} />
          </Section>
        )}

        {/* ===== SECCIÓN 6 — ESTADÍSTICAS CALCULADAS ===== */}
        {p && (
          <Section title="Estadísticas calculadas" icon="&#128202;" sectionKey="stats" collapsed={collapsed} toggle={toggleSection}>
            <div className="stats-grid">
              <StatCard title={`Goles — ${a.homeTeam}`} items={[
                { label: 'Prom. anotados', value: p.homeGoals.avgScored },
                { label: 'Prom. recibidos', value: p.homeGoals.avgConceded },
                { label: 'Prom. vs rival (H2H)', value: p.h2hGoals.homeAvg },
              ]} />
              <StatCard title={`Goles — ${a.awayTeam}`} items={[
                { label: 'Prom. anotados', value: p.awayGoals.avgScored },
                { label: 'Prom. recibidos', value: p.awayGoals.avgConceded },
                { label: 'Prom. vs rival (H2H)', value: p.h2hGoals.awayAvg },
              ]} />
              <StatCard title="Córners (últimos 5)" items={[
                { label: `${a.homeTeam} a favor`, value: p.cornerCardData?.homeCornersAvg ?? '—' },
                { label: `${a.homeTeam} en contra`, value: p.cornerCardData?.homeCornersAgainstAvg ?? '—' },
                { label: `${a.awayTeam} a favor`, value: p.cornerCardData?.awayCornersAvg ?? '—' },
                { label: `${a.awayTeam} en contra`, value: p.cornerCardData?.awayCornersAgainstAvg ?? '—' },
                { label: 'Total combinado', value: p.cornerAvg },
              ]} />
              <StatCard title="Tarjetas (últimos 5)" items={[
                { label: `${a.homeTeam} amarillas`, value: p.cornerCardData?.homeYellowsAvg ?? '—' },
                { label: `${a.homeTeam} rojas`, value: p.cornerCardData?.homeRedsAvg ?? '—' },
                { label: `${a.awayTeam} amarillas`, value: p.cornerCardData?.awayYellowsAvg ?? '—' },
                { label: `${a.awayTeam} rojas`, value: p.cornerCardData?.awayRedsAvg ?? '—' },
                { label: 'Total amarillas prom.', value: p.cardAvg },
              ]} />
            </div>
          </Section>
        )}

        {/* ===== SECCIÓN 6B — POR EQUIPO (estadísticas internas) ===== */}
        {p?.perTeam && (
          <Section title="Estadísticas por equipo" icon="&#9878;" sectionKey="perteam" collapsed={collapsed} toggle={toggleSection}>
            <PerTeamSection perTeam={p.perTeam} homeTeam={a.homeTeam} awayTeam={a.awayTeam} homeLogo={a.homeLogo} awayLogo={a.awayLogo} />
          </Section>
        )}

        {/* ===== SECCIÓN 6C — TIMING DE GOL ===== */}
        {p?.goalTiming && (
          <Section title="Probabilidad de gol por periodo" icon="&#9201;" sectionKey="timing" collapsed={collapsed} toggle={toggleSection}>
            <GoalTimingSection goalTiming={p.goalTiming} homeTeam={a.homeTeam} awayTeam={a.awayTeam} />
          </Section>
        )}

        {/* ===== SECCIÓN 7 — JUGADORES DESTACADOS ===== */}
        <Section title="Jugadores destacados" icon="&#9733;" sectionKey="players" collapsed={collapsed} toggle={toggleSection}>
          <PlayerHighlights highlights={a.playerHighlights} />
        </Section>

        {/* ===== SECCIÓN 8 — PROBABILIDADES CALCULADAS ===== */}
        {p && (
          <Section title="Probabilidades calculadas" icon="%" sectionKey="probs" collapsed={collapsed} toggle={toggleSection}>
            <div className="prob-grid">
              <div className="prob-card">
                <h4>Ambos marcan (BTTS)</h4>
                <ProbBar label="Sí" value={p.btts} />
                <ProbBar label="No" value={p.bttsNo} />
              </div>
              <div className="prob-card">
                <h4>Ganador del partido</h4>
                <ProbBar label={a.homeTeam} value={p.winner.home} />
                <ProbBar label="Empate" value={p.winner.draw} />
                <ProbBar label={a.awayTeam} value={p.winner.away} />
              </div>
              <div className="prob-card">
                <h4>Más/Menos goles</h4>
                <div className="prob-expected">Esperado: {p.overUnder.expectedTotal} goles</div>
                <ProbBar label="Más de 1.5" value={p.overUnder.over15} />
                <ProbBar label="Más de 2.5" value={p.overUnder.over25} />
                <ProbBar label="Más de 3.5" value={p.overUnder.over35} />
              </div>
              <div className="prob-card">
                <h4>Córners totales</h4>
                <ProbBar label="Más de 8.5" value={p.corners.over85} />
                <ProbBar label="Más de 9.5" value={p.corners.over95} />
                <ProbBar label="Más de 10.5" value={p.corners.over105} />
              </div>
              <div className="prob-card">
                <h4>Tarjetas totales</h4>
                <ProbBar label="Más de 2.5" value={p.cards.over25} />
                <ProbBar label="Más de 3.5" value={p.cards.over35} />
                <ProbBar label="Más de 4.5" value={p.cards.over45} />
              </div>
            </div>
          </Section>
        )}

        {/* ===== SECCIÓN 9 — COMBINADA AUTOMÁTICA ===== */}
        {/* Only show selections with real bookmaker odds (odd > 1). If < 2, hide entire section. */}
        {(() => {
          if (!c) return null;
          const validSels = c.selections.filter(sel => sel.odd && sel.odd > 1);
          if (validSels.length < 2) return null;
          const recalcOdd = validSels.reduce((acc, s) => acc * s.odd, 1);
          const recalcProb = validSels.reduce((acc, s) => acc + s.probability, 0) / validSels.length;
          const isHighRisk = recalcProb < 60;
          return (
            <Section title="Combinada automática" icon="&#127942;" sectionKey="combinada" collapsed={collapsed} toggle={toggleSection}>
              <div className="combinada-card">
                {isHighRisk && (
                  <div className="combinada-warning">
                    &#9888; Combinada de riesgo alto — probabilidad combinada: {cap(recalcProb)}%
                  </div>
                )}
                <div className="combinada-selections">
                  {validSels.map((sel, i) => {
                    const isHighProb = sel.probability >= 70 && sel.probability <= 95;
                    return (
                      <div key={i} className={`combinada-item ${isHighProb ? 'alta-prob' : ''}`}>
                        <div className="combinada-item-info">
                          <span className="combinada-num">#{i + 1}</span>
                          <span className="combinada-market">{sel.name}</span>
                          {isHighProb && <span className="alta-prob-badge">Alta prob.</span>}
                        </div>
                        <div className="combinada-item-data">
                          <ProbBar label="" value={sel.probability} compact />
                          <span className="combinada-prob">{cap(sel.probability)}%</span>
                          <span className="combinada-odd">{sel.odd.toFixed(2)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="combinada-footer">
                  <div className="combinada-total">
                    <span>Cuota combinada</span>
                    <strong>{recalcOdd.toFixed(2)}</strong>
                  </div>
                  <div className="combinada-total">
                    <span>Probabilidad combinada</span>
                    <strong className={isHighRisk ? 'danger' : 'safe'}>{cap(recalcProb)}%</strong>
                  </div>
                </div>
              </div>
            </Section>
          );
        })()}

        <div className="analysis-footer">
          {quota && <span>Llamadas usadas hoy: {quota.used}/{quota.limit}</span>}
        </div>
      </div>
    </div>
  );
}

// ===================== BAJAS SECTION =====================

function BajasSection({ filteredInjuries, allInjuries, homeUsualXI, awayUsualXI, homeTeam, awayTeam, onRefresh, refreshing }) {
  const hasInjuryData = allInjuries && allInjuries.length > 0;
  const filtered = filteredInjuries || [];

  if (!hasInjuryData) {
    return (
      <div className="no-data-section">
        <p>Sin bajas confirmadas aún</p>
        <button className="btn-secondary" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Actualizando...' : 'Actualizar bajas'}
        </button>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="no-data-section positive">
        <p>&#9989; Once titular sin bajas confirmadas</p>
        <button className="btn-secondary mt" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Actualizando...' : 'Actualizar bajas'}
        </button>
      </div>
    );
  }

  return (
    <div className="injuries-list">
      <div className="injury-warning">
        &#9888; {filtered.length} baja{filtered.length > 1 ? 's' : ''} en el once titular
      </div>
      {filtered.map((inj, i) => (
        <div key={i} className="injury-item">
          <TeamLogo src={inj.team?.logo} name={inj.team?.name} size={20} />
          <span className="injury-player">{inj.player?.name}</span>
          <span className="injury-type">{inj.player?.type}</span>
          <span className="injury-reason">{inj.player?.reason || 'N/A'}</span>
        </div>
      ))}
      <button className="btn-secondary mt" onClick={onRefresh} disabled={refreshing}>
        {refreshing ? 'Actualizando...' : 'Actualizar bajas'}
      </button>
    </div>
  );
}

// ===================== PLAYER HIGHLIGHTS =====================

function PlayerHighlights({ highlights }) {
  if (!highlights) return <div className="no-data-section"><p>Sin datos de jugadores</p></div>;

  const { shooters, scorers } = highlights;
  const hasData = (shooters && shooters.length > 0) || (scorers && scorers.length > 0);

  if (!hasData) return <div className="no-data-section"><p>Sin jugadores destacados identificados</p></div>;

  return (
    <div className="players-highlights">
      {scorers && scorers.length > 0 && (
        <div className="highlight-group">
          <h5>&#9917; Goleadores en racha <small>(gol en 3+ de últimos 5 partidos)</small></h5>
          {scorers.map((p, i) => (
            <div key={i} className="highlight-player">
              <span className="hp-name">{p.name}</span>
              <span className="hp-team">{p.teamName}</span>
              <span className="hp-stat">{p.totalGoals} goles</span>
              <div className="hp-indicators">
                {p.goals.map((g, j) => (
                  <span key={j} className={`hp-dot ${g > 0 ? 'scored' : 'miss'}`} title={g > 0 ? `${g} gol(es)` : 'Sin gol'}>
                    {g > 0 ? g : '—'}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {shooters && shooters.length > 0 && (
        <div className="highlight-group">
          <h5>&#127919; Rematadores consistentes <small>(remate a puerta en 4+ de últimos 5)</small></h5>
          {shooters.map((p, i) => (
            <div key={i} className="highlight-player">
              <span className="hp-name">{p.name}</span>
              <span className="hp-team">{p.teamName}</span>
              <span className="hp-stat">{p.totalShots} remates</span>
              <div className="hp-indicators">
                {p.shotsOnGoal.map((s, j) => (
                  <span key={j} className={`hp-dot ${s > 0 ? 'scored' : 'miss'}`}>
                    {s > 0 ? s : '—'}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===================== SUB-COMPONENTS =====================

function TeamLogo({ src, name, size = 32 }) {
  const [err, setErr] = useState(false);
  if (!src || err) {
    return (
      <div className="team-logo-fallback" style={{ width: size, height: size, fontSize: size * 0.4 }}>
        {(name || '?').slice(0, 2).toUpperCase()}
      </div>
    );
  }
  return <img src={src} alt={name} width={size} height={size} style={{ objectFit: 'contain' }} onError={() => setErr(true)} />;
}

function Section({ title, icon, sectionKey, collapsed, toggle, children }) {
  const isCollapsed = collapsed[sectionKey];
  return (
    <div className="analysis-section">
      <button className="section-header" onClick={() => toggle(sectionKey)}>
        <span className="section-icon">{icon}</span>
        <span className="section-title">{title}</span>
        <span className={`section-chevron ${isCollapsed ? 'collapsed' : ''}`}>&#9660;</span>
      </button>
      {!isCollapsed && <div className="section-content">{children}</div>}
    </div>
  );
}

function OddBadge({ label, value }) {
  if (!value) return null;
  return (
    <div className="odd-badge">
      <span className="odd-label">{label}</span>
      <span className="odd-value">{value.toFixed(2)}</span>
    </div>
  );
}

function ProbBar({ label, value, compact = false }) {
  const display = cap(value);
  const barColor = display >= 75 ? 'var(--green)' : display >= 50 ? 'var(--yellow)' : 'var(--red)';
  return (
    <div className={`prob-bar-row ${compact ? 'compact' : ''}`}>
      {label && <span className="prob-label">{label}</span>}
      <div className="prob-bar-track">
        <div className="prob-bar-fill" style={{ width: `${display}%`, background: barColor }} />
      </div>
      {!compact && <span className="prob-value">{display}%</span>}
    </div>
  );
}

function StatCard({ title, items }) {
  return (
    <div className="stat-card">
      <h5>{title}</h5>
      {items.map((item, i) => (
        <div key={i} className="stat-row">
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function Last5Table({ team, logo, teamId, form, lastFive }) {
  if (!form || !form.results.length) return <div className="no-data-section"><p>Sin datos</p></div>;

  // Use enriched data from lastFive if available, otherwise fall back to form.results
  const hasEnriched = lastFive && lastFive.length > 0 && lastFive[0]?._enriched;

  return (
    <div className="last5-team">
      <div className="last5-header">
        <TeamLogo src={logo} name={team} size={24} />
        <span>{team}</span>
        <span className="form-points">{form.points}/{form.maxPoints} pts</span>
      </div>
      <div className="form-dots">
        {form.results.map((r, i) => (
          <span key={i} className={`form-dot ${r.result.toLowerCase()}`} title={`${r.result} vs ${r.opponent}`}>
            {r.result}
          </span>
        ))}
      </div>
      <div className="last5-table">
        {hasEnriched ? (
          lastFive.map((match, i) => {
            const e = match._enriched;
            return (
              <div key={i} className="last5-match">
                <span className={`last5-result-dot ${e.result.toLowerCase()}`}>{e.result}</span>
                <span className="last5-match-score">{e.score}</span>
                <span className="last5-match-venue">{e.isHome ? 'L' : 'V'}</span>
                {e.opponentLogo && (
                  <img src={e.opponentLogo} alt="" className="last5-opp-logo" />
                )}
                <span className="last5-match-opponent">{e.opponentName}</span>
                {e.corners && (
                  <span className="last5-stat" title="Corners">
                    <span className="ls-icon corner-icon">&#9873;</span>{e.corners.total}
                  </span>
                )}
                {e.yellowCards && e.yellowCards.total > 0 && (
                  <span className="last5-stat" title="Amarillas">
                    <span className="yellow-card-sm" />{e.yellowCards.total}
                  </span>
                )}
                {e.redCards && e.redCards.total > 0 && (
                  <span className="last5-stat" title="Rojas">
                    <span className="red-card-sm" />{e.redCards.total}
                  </span>
                )}
              </div>
            );
          })
        ) : (
          form.results.map((r, i) => (
            <div key={i} className="last5-match">
              <span className={`last5-result-dot ${r.result.toLowerCase()}`}>{r.result}</span>
              <span className="last5-match-score">{r.goalsFor}-{r.goalsAgainst}</span>
              <span className="last5-match-venue">{r.wasHome ? 'L' : 'V'}</span>
              {r.opponentLogo && (
                <img src={r.opponentLogo} alt="" className="last5-opp-logo" />
              )}
              <span className="last5-match-opponent">{r.opponent}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function H2HSection({ h2h, homeTeam, awayTeam, homeId, summary }) {
  if (!h2h || h2h.length === 0) return <div className="no-data-section"><p>Sin historial H2H</p></div>;

  return (
    <div className="h2h-section">
      <div className="h2h-summary">
        <div className="h2h-stat home">{summary.homeWins} <small>{homeTeam}</small></div>
        <div className="h2h-stat draw">{summary.draws} <small>Empates</small></div>
        <div className="h2h-stat away">{summary.awayWins} <small>{awayTeam}</small></div>
      </div>
      <div className="h2h-table">
        {h2h.map((f, i) => {
          const hg = f.goals?.home ?? 0;
          const ag = f.goals?.away ?? 0;
          const date = f.fixture?.date ? fmtShortDate(f.fixture.date) : '';
          const fHomeId = f.teams?.home?.id;
          // Determine winner to highlight
          let winnerClass = '';
          if (hg > ag) winnerClass = fHomeId === homeId ? 'home-win' : 'away-win';
          else if (ag > hg) winnerClass = fHomeId === homeId ? 'away-win' : 'home-win';
          else winnerClass = 'draw-result';

          const stats = f._stats || {};
          return (
            <div key={i} className={`h2h-row ${winnerClass}`}>
              <span className="h2h-date">{date}</span>
              <span className="h2h-home-team">{f.teams?.home?.name}</span>
              <span className="h2h-result">{hg} - {ag}</span>
              <span className="h2h-away-team">{f.teams?.away?.name}</span>
              {(stats.corners || stats.yellowCards || stats.redCards) && (
                <span className="h2h-stats-row">
                  {stats.corners && <span className="h2h-stat-badge" title={`Corners: ${stats.corners.home}-${stats.corners.away}`}>&#9873; {stats.corners.total}</span>}
                  {stats.yellowCards && stats.yellowCards.total > 0 && <span className="h2h-stat-badge yellow" title={`Amarillas: ${stats.yellowCards.home}-${stats.yellowCards.away}`}><span className="yellow-card-sm"></span> {stats.yellowCards.total}</span>}
                  {stats.redCards && stats.redCards.total > 0 && <span className="h2h-stat-badge red" title={`Rojas: ${stats.redCards.home}-${stats.redCards.away}`}><span className="red-card-sm"></span> {stats.redCards.total}</span>}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===================== ODDS WITH BOOKMAKER =====================

function OddsWithBookmaker({ odds, allBookmakerOdds, userCountry }) {
  // Use selectBookmakerOdds with the full odds object to pick the best bookmaker for matchWinner
  const selected = selectBookmakerOdds(odds, 'matchWinner', userCountry);
  const mw = selected?.odds || odds.matchWinner;
  const bkName = selected?.bookmaker || odds.bookmaker;
  const bkNameLower = bkName ? bkName.toLowerCase() : '';
  const bkLogo = bkNameLower ? BOOKMAKER_LOGOS[bkNameLower] || Object.entries(BOOKMAKER_LOGOS).find(([k]) => bkNameLower.includes(k))?.[1] : null;

  return (
    <div className="odds-row">
      <OddBadge label="1" value={mw?.home} />
      <OddBadge label="X" value={mw?.draw} />
      <OddBadge label="2" value={mw?.away} />
      <span className="odds-bk-info">
        {bkLogo && <img src={bkLogo} alt={bkName} className="odds-bk-logo-lg" />}
      </span>
    </div>
  );
}

// ===================== PER-TEAM SECTION =====================

function PerTeamSection({ perTeam, homeTeam, awayTeam, homeLogo, awayLogo }) {
  const thresholdLabels = {
    corners: { over05: '+0.5', over15: '+1.5', over25: '+2.5', over35: '+3.5', over45: '+4.5', over55: '+5.5' },
    cards: { over05: '+0.5', over15: '+1.5', over25: '+2.5', over35: '+3.5' },
    goals: { over05: '+0.5', over15: '+1.5', over25: '+2.5' },
  };

  const categoryLabels = { corners: 'Corners', cards: 'Tarjetas', goals: 'Goles' };

  function renderTeamCol(teamData, teamName, teamLogo) {
    return (
      <div className="perteam-col">
        <div className="perteam-col-header">
          <TeamLogo src={teamLogo} name={teamName} size={20} />
          <span>{teamName}</span>
        </div>
        {Object.entries(categoryLabels).map(([cat, label]) => {
          const catData = teamData?.[cat];
          if (!catData) return null;
          const entries = Object.entries(catData)
            .filter(([, prob]) => prob >= 50)
            .map(([key, prob]) => ({ label: thresholdLabels[cat]?.[key] || key, prob }));
          if (entries.length === 0) return null;
          return (
            <div key={cat} className="perteam-category">
              <span className="perteam-cat-label">{label}</span>
              {entries.map((e, i) => (
                <div key={i} className="perteam-item">
                  <span className="perteam-threshold">{e.label}</span>
                  <div className="perteam-bar-track">
                    <div
                      className="perteam-bar-fill"
                      style={{
                        width: `${cap(e.prob)}%`,
                        background: e.prob >= 75 ? 'var(--green)' : e.prob >= 60 ? 'var(--yellow)' : 'var(--blue)',
                      }}
                    />
                  </div>
                  <span className="perteam-prob">{cap(e.prob)}%</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="perteam-grid">
      {renderTeamCol(perTeam.home, homeTeam, homeLogo)}
      {renderTeamCol(perTeam.away, awayTeam, awayLogo)}
    </div>
  );
}

// ===================== GOAL TIMING SECTION =====================

function GoalTimingSection({ goalTiming, homeTeam, awayTeam }) {
  const periods = ['0-15', '15-30', '30-45', '45-60', '60-75', '75-90'];

  function getTimingColor(prob) {
    if (prob >= 70) return 'timing-high';
    if (prob >= 50) return 'timing-mid';
    return 'timing-low';
  }

  // Aggregate halves
  const aggregate = (data, startIdx, endIdx) => {
    if (!data || data.length === 0) return 0;
    let sum = 0;
    for (let i = startIdx; i <= endIdx; i++) {
      sum += data[i]?.probability || 0;
    }
    return Math.min(95, Math.round(sum / (endIdx - startIdx + 1)));
  };

  const home1H = aggregate(goalTiming.home, 0, 2);
  const home2H = aggregate(goalTiming.home, 3, 5);
  const away1H = aggregate(goalTiming.away, 0, 2);
  const away2H = aggregate(goalTiming.away, 3, 5);
  const comb1H = aggregate(goalTiming.combined, 0, 2);
  const comb2H = aggregate(goalTiming.combined, 3, 5);

  return (
    <div className="timing-section">
      {/* Period grid */}
      <div className="timing-grid">
        <div className="timing-header-row">
          <span className="timing-team-label"></span>
          {periods.map(p => <span key={p} className="timing-period-label">{p}'</span>)}
        </div>
        {/* Home */}
        <div className="timing-data-row">
          <span className="timing-team-label">{homeTeam}</span>
          {goalTiming.home.map((d, i) => (
            <span key={i} className={`timing-cell ${getTimingColor(d.probability)}`}>
              {cap(d.probability)}%
            </span>
          ))}
        </div>
        {/* Away */}
        <div className="timing-data-row">
          <span className="timing-team-label">{awayTeam}</span>
          {goalTiming.away.map((d, i) => (
            <span key={i} className={`timing-cell ${getTimingColor(d.probability)}`}>
              {cap(d.probability)}%
            </span>
          ))}
        </div>
        {/* Combined */}
        <div className="timing-data-row timing-combined-row">
          <span className="timing-team-label">Combinado</span>
          {goalTiming.combined.map((d, i) => (
            <span key={i} className={`timing-cell ${getTimingColor(d.probability)}`}>
              {cap(d.probability)}%
            </span>
          ))}
        </div>
      </div>

      {/* Half aggregates */}
      <div className="timing-halves">
        <div className="timing-half-card">
          <span className="timing-half-title">1ra mitad</span>
          <div className="timing-half-row">
            <span className="timing-half-team">{homeTeam}</span>
            <span className={`timing-half-val ${getTimingColor(home1H)}`}>{home1H}%</span>
          </div>
          <div className="timing-half-row">
            <span className="timing-half-team">{awayTeam}</span>
            <span className={`timing-half-val ${getTimingColor(away1H)}`}>{away1H}%</span>
          </div>
          <div className="timing-half-row timing-half-combined">
            <span className="timing-half-team">Combinado</span>
            <span className={`timing-half-val ${getTimingColor(comb1H)}`}>{comb1H}%</span>
          </div>
        </div>
        <div className="timing-half-card">
          <span className="timing-half-title">2da mitad</span>
          <div className="timing-half-row">
            <span className="timing-half-team">{homeTeam}</span>
            <span className={`timing-half-val ${getTimingColor(home2H)}`}>{home2H}%</span>
          </div>
          <div className="timing-half-row">
            <span className="timing-half-team">{awayTeam}</span>
            <span className={`timing-half-val ${getTimingColor(away2H)}`}>{away2H}%</span>
          </div>
          <div className="timing-half-row timing-half-combined">
            <span className="timing-half-team">Combinado</span>
            <span className={`timing-half-val ${getTimingColor(comb2H)}`}>{comb2H}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}
