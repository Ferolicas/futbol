'use client';
import { useFreeAccess, LockedAnalysis } from '../../components/FreeAccessProvider';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Zap, AlertTriangle, TrendingUp, Star, Users, BarChart3, Percent, History, Clock, Layers3,
} from 'lucide-react';
import { marketLabel } from '../../../../lib/market-labels';
import { meetsFootballReliability } from '../../../../lib/recommendation-policy';
import { marketResultState, settleMarketSelection } from '../../../../lib/market-settlement';
import { getAnalysisCache, setAnalysisCache } from '../../../../lib/analysis-cache';
import {
  mergeLiveStats,
  setFixtureLiveStats,
  useFixtureLiveStats,
} from '../../realtime/fixture-store';
import { useSelectedMarkets } from '../../selected-markets-context';
import { getUserTz, todayInTz } from '../../../../lib/timezone';
import { useWorkerSocketState } from '../../../../hooks/useWorkerSocket';
import DashboardBuffer from '../../components/DashboardBuffer';
import FinalVerdictPanel from '../../components/FinalVerdictPanel';
import { AccordionProbBlock, AccordionPlayersBlock, MatchHeadCard } from '../../page';
import { AccordionSection, DocPage, Grid, H2HTable, MarketCard, Panel, StatTile } from '../../components/FullAnalysisKit';

const cap = (v) => {
  const value = Math.max(0, Math.min(100, Number(v) || 0));
  if (value >= 95) return 95;
  return Math.floor((value + 1e-9) * 100) / 100;
};
const isClockRunning = (s) => ['1H', '2H', 'ET', 'LIVE'].includes(s);
export function AnalysisExperience(props) {
  const { isFree } = useFreeAccess();
  return isFree ? <div className="app free-detail"><LockedAnalysis title="Análisis completo" /></div> : <PaidAnalysisExperience {...props} />;
}

function PaidAnalysisExperience({ fixtureId: fixtureIdProp, embedded = false, onClose }) {
  const params = useParams();
  const router = useRouter();
  const fixtureId = fixtureIdProp || params.id;
  const closeOrBack = () => {
    if (embedded && onClose) onClose();
    else router.push('/dashboard');
  };

  // Hydrate from hand-off cache so the page renders instantly when arriving
  // from the dashboard — then revalidate in background via fetch.
  const initialCached = typeof window !== 'undefined' ? getAnalysisCache(fixtureId) : null;
  const initialAnalysis = initialCached?.analysis || null;
  // Motor de contexto = única ruta: el análisis SIEMPRE trae calculatedProbabilities
  // y combinada. Sin fallback Dixon-Coles en cliente.
  const initialProbs     = initialAnalysis?.calculatedProbabilities || null;
  const initialCombinada = initialAnalysis?.combinada || null;

  const [analysis, setAnalysis] = useState(initialAnalysis);
  const [loading, setLoading] = useState(!initialAnalysis);
  const [error, setError] = useState('');
  const [probabilities, setProbabilities] = useState(initialProbs);
  const [combinada, setCombinada] = useState(initialCombinada);
  const { selectedMarkets, toggleMarket } = useSelectedMarkets();
  const [collapsed, setCollapsed] = useState({});
  const [notAnalyzed, setNotAnalyzed] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [refreshingLineups, setRefreshingLineups] = useState(false);
  const [refreshingInjuries, setRefreshingInjuries] = useState(false);
  const liveStats = useFixtureLiveStats(fixtureId);
  // F1: estado del WebSocket. El marcador/stats en vivo llegan por WS vía el
  // store granular (suscripción exclusiva a este fixture). El poll HTTP de 15s
  // solo se usa como FALLBACK cuando el WS NO está conectado.
  const wsState = useWorkerSocketState();
  const [, tickLive] = useState(0);

  // Tick every second while match is live so the counter updates in real-time
  const liveStatusShort = liveStats?.status?.short;
  useEffect(() => {
    if (!isClockRunning(liveStatusShort)) return;
    const id = setInterval(() => tickLive(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [liveStatusShort]);

  const toggleSection = (key) => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));

  const doAnalyze = async () => {
    setAnalyzing(true);
    setError('');
    try {
      const localDate = todayInTz(getUserTz());
      const res = await fetch(`/api/match/${fixtureId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'analyze', date: localDate }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      setNotAnalyzed(false);
      setAnalysis(data.analysis);
      setProbabilities(data.analysis.calculatedProbabilities || null);
      setCombinada(data.analysis.combinada || null);
    } catch (e) {
      setError(e.message || 'Error al analizar');
    } finally {
      setAnalyzing(false);
    }
  };

  const loadAnalysis = useCallback(async ({ silent } = {}) => {
    if (!silent) setLoading(true);
    setError('');
    setNotAnalyzed(false);
    try {
      const localDate = todayInTz(getUserTz());
      const res = await fetch(`/api/match/${fixtureId}?date=${localDate}`);
      const data = await res.json();
      if (data.notFound) { setNotAnalyzed(true); return; }
      if (data.error) { setError(data.error); return; }
      setAnalysis(data.analysis);
      setProbabilities(data.analysis.calculatedProbabilities || null);
      setCombinada(data.analysis.combinada || null);
      if (data.resultStats) {
        setFixtureLiveStats(fixtureId, data.resultStats);
      }
      // Refresh the hand-off cache so a quick back-and-forth uses the fresher data
      setAnalysisCache(fixtureId, { analysis: data.analysis });
    } catch (e) {
      if (!silent) setError(e.message || 'Error loading analysis');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [fixtureId]);

  // On mount: if we hydrated from the hand-off cache, fetch silently in the
  // background so the user sees instant content. Otherwise fetch with spinner.
  useEffect(() => {
    loadAnalysis({ silent: !!initialAnalysis });
  }, [loadAnalysis]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!analysis) return;
    const existing = liveStats;
    // Un cierre durable también es una respuesta completa cuando el proveedor
    // solo cubre marcador/goles. No repetir peticiones buscando mercados que no
    // existen para esa competición.
    if (existing?.realFinal) return;
    if (existing && (existing.corners || existing.yellowCards || existing.goalScorers?.length || existing.cardEvents?.length)) return;

    const loadStats = async () => {
      try {
        const isFinished = ['FT', 'AET', 'PEN'].includes(analysis?.status?.short);
        if (!isFinished) {
          const refreshRes = await fetch('/api/refresh-live');
          const refreshData = await refreshRes.json();
          if (refreshData.liveStats && Object.keys(refreshData.liveStats).length > 0) {
            mergeLiveStats(refreshData.liveStats);
            return;
          }
        }
        const res = await fetch(`/api/live-poll?fixtureId=${fixtureId}`);
        const data = await res.json();
        const matchStats = data.liveStats?.find(s => Number(s.fixtureId) === Number(fixtureId));
        if (matchStats) {
          setFixtureLiveStats(fixtureId, matchStats);
          return;
        }
        const fetchRes = await fetch(`/api/match/${fixtureId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'refresh-stats' }),
        });
        const fetchData = await fetchRes.json();
        if (fetchData.stats) {
          setFixtureLiveStats(fixtureId, fetchData.stats);
        }
      } catch {}
    };

    loadStats();
  }, [fixtureId, !!analysis]); // eslint-disable-line react-hooks/exhaustive-deps

  // F1: poll de stats (córners/tarjetas/scorers) cada 15s SOLO COMO FALLBACK
  // cuando el WebSocket NO está conectado. Con el WS conectado, el store
  // granular recibe los updates en tiempo real (a los ~ms del tick de 20s del
  // worker) y este poll queda desactivado → 0 tráfico redundante.
  useEffect(() => {
    const liveStatuses = ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT'];
    if (!liveStatuses.includes(liveStatusShort)) return;
    if (wsState === 'connected') return; // WS activo → no hace falta poll

    const pollLiveStats = async () => {
      try {
        const res = await fetch(`/api/live-poll?fixtureId=${fixtureId}`);
        const data = await res.json();
        const matchStats = data.liveStats?.find(s => Number(s.fixtureId) === Number(fixtureId));
        if (matchStats) {
          setFixtureLiveStats(fixtureId, matchStats);
        }
      } catch {}
    };

    pollLiveStats(); // primer fetch inmediato al perder el WS
    const intervalId = setInterval(pollLiveStats, 15000);
    return () => clearInterval(intervalId);
  }, [fixtureId, liveStatusShort, wsState]);

  useEffect(() => {
    if (!liveStats?.status) return;
    setAnalysis(prev => prev ? ({
      ...prev,
      status: liveStats.status,
      goals: liveStats.goals || prev.goals,
    }) : prev);
  }, [liveStats?.status?.short, liveStats?.goals?.home, liveStats?.goals?.away]); // eslint-disable-line react-hooks/exhaustive-deps

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
        if (!data.lineups.available) setLineupsError('Alineaciones aún no publicadas');
      }
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
    } catch {} finally { setRefreshingInjuries(false); }
  };

  // ── LOADING ──
  if (loading) {
    return <DashboardBuffer compact={embedded} />;
  }

  const title = 'Fútbol · análisis completo';

  // ── NOT ANALYZED YET ──
  if (notAnalyzed) {
    return (
      <DocPage onBack={closeOrBack} title={title} embedded={embedded}>
        <div className="fak-notice">
          <strong>Partido sin analizar</strong>
          <p className="fak-muted" style={{ margin: 0 }}>Este partido aún no tiene análisis. Puedes generarlo ahora.</p>
          {error && <div className="fak-error">{error}</div>}
          <button type="button" className="fak-btn is-primary" onClick={doAnalyze} disabled={analyzing}>
            <Zap size={16} aria-hidden="true" /> {analyzing ? 'Analizando…' : 'Analizar partido'}
          </button>
        </div>
      </DocPage>
    );
  }

  // ── ERROR ──
  if (error && !analysis) {
    return (
      <DocPage onBack={closeOrBack} title={title} embedded={embedded}>
        <div className="fak-error">{error}</div>
        <button type="button" className="fak-btn" onClick={() => loadAnalysis()}>Reintentar</button>
      </DocPage>
    );
  }

  if (!analysis) return null;
  const a = analysis;
  const p = probabilities;
  const tz = getUserTz();
  const match = {
    fixture: { id: Number(fixtureId), date: a.kickoff, status: liveStats?.status || a.status || { short: 'NS' } },
    league: { name: a.league, logo: a.leagueLogo, id: a.leagueId },
    teams: { home: { id: a.homeId, name: a.homeTeam, logo: a.homeLogo }, away: { id: a.awayId, name: a.awayTeam, logo: a.awayLogo } },
    goals: liveStats?.goals || a.goals,
  };
  const markets = footballMarkets(a, match);
  const selected = selectedMarkets[fixtureId] || selectedMarkets[String(fixtureId)] || {};
  const matchName = `${a.homeTeam} vs ${a.awayTeam}`;
  const resultState = marketResultState({ sport: 'football', game: match, liveResult: liveStats });
  const pendingLabel = resultState.isLive ? 'En juego' : resultState.isFinal ? 'Pendiente oficial' : null;
  const lastFive = [[a.homeTeam, a.homeLastFive], [a.awayTeam, a.awayLastFive]].filter(([, list]) => Array.isArray(list) && list.length > 0);
  const hasPlayers = ['scorers', 'shooters', 'shotsTotalists', 'assisters', 'foulers', 'bookers']
    .some((key) => Array.isArray(a.playerHighlights?.[key]) && a.playerHighlights[key].length > 0);

  return (
    <DocPage onBack={closeOrBack} title={title} embedded={embedded}>
      <MatchHeadCard match={match} odds={a.odds?.matchWinner} data={a} liveStats={liveStats} userTz={tz} />
      {a.leagueRound && <p className="fak-round">{a.leagueRound}</p>}

      <AccordionSection title="Mercados para tu combinada" icon={Layers3} count={markets.length} hint="Líneas con fiabilidad ≥90%, cuota real ≥1.20 y probabilidad ≥70%.">
        {markets.length ? markets.map((mkt) => (
          <MarketCard key={mkt.id} name={mkt.name} probability={Number(mkt.rawProbability ?? mkt.probability)} odd={mkt.odd} bookmaker={mkt.bookmaker} expectedValue={mkt.expectedValue} seal={mkt.seal}
            validation={mkt.recommended ? 'Recomendación estadística' : 'Dato estadístico'} selected={!!selected[mkt.id]} onClick={() => toggleMarket(fixtureId, mkt, matchName)}
            outcome={settleMarketSelection({ sport: 'football', selection: mkt, game: match, liveResult: liveStats })} pendingLabel={pendingLabel} />
        )) : <p className="fak-empty">Todavía no hay opciones que cumplan los criterios de recomendación.</p>}
      </AccordionSection>

      <AccordionSection title="XI Alineación titular" icon={Users} accent="#22d3ee">
        {a.lineups?.available ? (
          <>
            {a.lineups.data.map((team, idx) => (
              <Panel key={idx}>
                <div className="fak-lineup-head">
                  {team.team?.logo && <img src={team.team.logo} alt="" loading="lazy" />}
                  <strong>{team.team?.name}</strong>
                  <b>{team.formation}</b>
                </div>
                <span className="fak-muted">DT: {team.coach?.name || 'N/A'}</span>
                <span className="fak-kicker">Titulares</span>
                {(team.startXI || []).map((pl, i) => (
                  <div key={i} className="fak-lineup-row"><span className="is-num">{pl.player?.number}</span><span className="is-name">{pl.player?.name}</span><span className="is-pos">{pl.player?.pos}</span></div>
                ))}
                {(team.substitutes || []).length > 0 && <span className="fak-kicker" style={{ marginTop: 6 }}>Suplentes</span>}
                {(team.substitutes || []).map((pl, i) => (
                  <div key={i} className="fak-lineup-row" style={{ opacity: .7 }}><span className="is-num">{pl.player?.number}</span><span className="is-name">{pl.player?.name}</span><span className="is-pos">{pl.player?.pos}</span></div>
                ))}
              </Panel>
            ))}
            <button type="button" className="fak-btn" onClick={doRefreshLineups} disabled={refreshingLineups}>{refreshingLineups ? 'Actualizando…' : 'Actualizar alineaciones'}</button>
          </>
        ) : (
          <div className="fak-notice is-warning">
            <AlertTriangle size={28} color="#fbbf24" aria-hidden="true" />
            <strong>Alineaciones no disponibles aún</strong>
            <button type="button" className="fak-btn is-primary" onClick={doRefreshLineups} disabled={refreshingLineups}>{refreshingLineups ? 'Actualizando…' : 'Actualizar alineaciones'}</button>
            {lineupsError && <span style={{ color: '#fb7185', fontSize: '.78rem' }}>{lineupsError}</span>}
          </div>
        )}
      </AccordionSection>

      <AccordionSection title="Bajas en el titular habitual" icon={AlertTriangle} accent="#fb7185">
        <InjuriesBlock filteredInjuries={a.filteredInjuries} allInjuries={a.injuries} onRefresh={doRefreshInjuries} refreshing={refreshingInjuries} />
      </AccordionSection>

      {lastFive.length > 0 && (
        <AccordionSection title="Últimos 5 partidos" icon={TrendingUp} accent="#22c55e">
          {lastFive.map(([name, list]) => (
            <Panel key={name} title={name}>
              {list.map((m, i) => {
                // /api/match/[id] devuelve la forma cruda (_enriched), no el
                // resumen compacto {r,gF,gA,op} de la lista de "Analizados".
                const e = m._enriched || m;
                const result = e.result ?? m.r;
                const corners = (e.corners ?? m.c)?.total;
                const yellows = (e.yellowCards ?? m.y)?.total;
                return (
                  <div key={i} className="fak-last-row">
                    <span className="fak-result" style={{ background: result === 'W' ? '#5ee6b1' : result === 'L' ? '#fb7185' : '#fbbf24' }}>{result || '?'}</span>
                    <span className="is-score">{e.goalsFor ?? m.gF ?? '?'}-{e.goalsAgainst ?? m.gA ?? '?'}</span>
                    <span className="is-opp">vs {e.opponentName ?? m.op ?? '?'}</span>
                    <span className="is-c">{corners != null ? `${corners}C` : '—'}</span>
                    <span className="is-t">{yellows != null ? `${yellows}T` : '—'}</span>
                  </div>
                );
              })}
            </Panel>
          ))}
          <p className="fak-faint" style={{ margin: 0 }}>C = córners · T = tarjetas amarillas del partido.</p>
        </AccordionSection>
      )}

      {Array.isArray(a.h2h) && a.h2h.length > 0 && (
        <AccordionSection title="Historial H2H" icon={History} accent="#a855f7" count={Math.min(8, a.h2h.length)}>
          <H2HTable rows={a.h2h.slice(0, 8).map((h) => ({ date: h.fixture?.date, home: h.teams?.home?.name, away: h.teams?.away?.name, hs: h.goals?.home, as: h.goals?.away }))} />
        </AccordionSection>
      )}

      {p && (
        <AccordionSection title="Estadísticas calculadas" icon={BarChart3} accent="#f97316">
          <Panel title="Goles por partido">
            <Grid columns={2}>
              {[[a.homeTeam, p.homeGoals], [a.awayTeam, p.awayGoals]].map(([name, stats]) => (
                <div key={name} style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                  <strong style={{ fontSize: '.74rem', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</strong>
                  <Grid columns={2}>
                    <StatTile label="Anotados" value={stats?.avgScored ?? '—'} />
                    <StatTile label="Recibidos" value={stats?.avgConceded ?? '—'} color="#fb7185" />
                  </Grid>
                </div>
              ))}
            </Grid>
          </Panel>
          <Panel title="Total combinado por partido">
            <Grid columns={2}>
              <StatTile label="Córners" value={p.cornerAvg ?? '—'} color="#22d3ee" />
              <StatTile label="Tarjetas" value={p.cardAvg ?? '—'} color="#fbbf24" />
            </Grid>
          </Panel>
        </AccordionSection>
      )}

      {p?.goalTiming && (
        <AccordionSection title="Probabilidad de gol por periodo" icon={Clock} accent="#818cf8">
          <GoalTimingHeatmap goalTiming={p.goalTiming} homeTeam={a.homeTeam} awayTeam={a.awayTeam} />
        </AccordionSection>
      )}

      {hasPlayers && (
        <AccordionSection title="Jugadores destacados" icon={Star} accent="#fbbf24">
          <AccordionPlayersBlock highlights={a.playerHighlights} />
        </AccordionSection>
      )}

      <AccordionSection title="Frecuencias calculadas" icon={Percent} accent="#2dd4bf">
        {p ? <AccordionProbBlock probabilities={p} odds={a.odds} homeTeam={a.homeTeam} awayTeam={a.awayTeam} /> : <p className="fak-empty">Las frecuencias aparecerán cuando termine el análisis.</p>}
      </AccordionSection>

      <FinalVerdictPanel verdict={a.finalVerdict} homeName={a.homeTeam} awayName={a.awayTeam} />
    </DocPage>
  );
}

export default function AnalisisPage() {
  return <AnalysisExperience />;
}

/** Catálogo "Mercados para tu combinada": mismo filtro que la tarjeta del
 * dashboard (fiabilidad ≥90%, cuota ≥1.20, probabilidad ≥70%). */
function footballMarkets(data, match) {
  const isEngine = data?.combinada?.source === 'context-engine';
  const sels = isEngine ? (data.combinada.selectable || data.combinada.selections || []) : [];
  return sels
    .filter((s) => meetsFootballReliability(s.confidence) && s.odd && s.odd >= 1.2 && Number(s.rawProbability ?? s.probability) >= 70)
    .map((s, index) => ({
      ...s,
      id: s.id || `mkt-${index}`,
      name: s.scope === 'context' ? marketLabel(s.id, { home: match.teams.home.name, away: match.teams.away.name }) : s.name,
      bookmaker: s.bookmaker || null,
      recommended: s.recommended === true,
    }))
    .sort((l, r) => Number(r.rawProbability ?? r.probability) - Number(l.rawProbability ?? l.probability));
}

/** Bajas del once titular (misma lógica que antes, maqueta de la app). */
function InjuriesBlock({ filteredInjuries, allInjuries, onRefresh, refreshing }) {
  const hasData = Array.isArray(allInjuries) && allInjuries.length > 0;
  const filtered = filteredInjuries || [];
  const refreshBtn = <button type="button" className="fak-btn" onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Actualizando…' : 'Actualizar bajas'}</button>;
  if (!hasData) return <div className="fak-notice"><span className="fak-muted">Sin bajas confirmadas aún</span>{refreshBtn}</div>;
  if (filtered.length === 0) return <div className="fak-notice is-success"><strong>Once titular sin bajas confirmadas</strong>{refreshBtn}</div>;
  return (
    <>
      <strong style={{ color: '#fb7185', fontSize: '.84rem', display: 'flex', alignItems: 'center', gap: 8 }}><AlertTriangle size={16} aria-hidden="true" /> {filtered.length} baja{filtered.length > 1 ? 's' : ''} en el once titular</strong>
      <Grid columns={2}>
        {filtered.map((inj, i) => (
          <div key={i} className="fak-injury">
            <span className="fak-injury-team">{inj.team?.logo && <img src={inj.team.logo} alt="" loading="lazy" />}{inj.team?.name}</span>
            <strong style={{ fontSize: '.84rem' }}>{inj.player?.name}</strong>
            <span style={{ fontSize: '.72rem' }}><span style={{ color: '#fb7185' }}>{inj.player?.type}</span> · <span style={{ color: '#fbbf24' }}>{inj.player?.reason || 'N/A'}</span></span>
          </div>
        ))}
      </Grid>
      {refreshBtn}
    </>
  );
}

// Heatmap rojo→verde (hue 0=rojo a 120=verde interpolado por porcentaje real).
function heatmapColor(prob) {
  const pct = Math.max(0, Math.min(100, Number(prob) || 0));
  return { background: `hsl(${(pct / 100) * 120}, 70%, 32%)`, color: pct >= 40 && pct <= 65 ? '#1a1a1a' : '#fff' };
}

/** Probabilidad de gol por periodo de 15': 6 columnas iguales por fila. */
function GoalTimingHeatmap({ goalTiming, homeTeam, awayTeam }) {
  const periods = ['0-15', '15-30', '30-45', '45-60', '60-75', '75-90'];
  const at = (data, i) => cap(data?.[i]?.probability || 0);
  return (
    <div className="fak-heat">
      <div className="fak-heat-row">{periods.map((period) => <small key={period}>{period}&apos;</small>)}</div>
      {[['Combinado', goalTiming.combined], [homeTeam, goalTiming.home], [awayTeam, goalTiming.away]].map(([label, data]) => (
        <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span className="fak-kicker">{label}</span>
          <div className="fak-heat-row">
            {periods.map((period, i) => {
              const value = at(data, i);
              const heat = heatmapColor(value);
              return <span key={period} className="fak-heat-cell" style={{ background: heat.background, color: heat.color }}>{Math.round(value)}%</span>;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
