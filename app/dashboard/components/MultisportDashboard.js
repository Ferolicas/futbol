'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import useSWR from 'swr';
import { BarChart3, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { fetcher } from '../../../lib/fetcher';
import { usePusherEvent } from '../../../lib/use-pusher';
import DashboardBuffer from './DashboardBuffer';

function detectTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
}

function dateInZone(timeZone) {
  try { return new Date().toLocaleDateString('en-CA', { timeZone }); }
  catch { return new Date().toISOString().slice(0, 10); }
}

function shiftDay(date, amount) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + amount);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function gameTime(value, timeZone) {
  try { return new Date(value).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone }); }
  catch { return '--:--'; }
}

function dayLabel(date) {
  try { return new Date(`${date}T12:00:00`).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }); }
  catch { return date; }
}

function probability(entry) {
  const value = Number(entry?.probability ?? entry);
  return Number.isFinite(value) ? value : null;
}

function evidence(entry) {
  return entry?.evidence || null;
}

function bestTotal(probabilities) {
  const lines = Object.entries(probabilities?.totals?.lines || {});
  if (!lines.length) return null;
  return lines.map(([line, values]) => {
    const over = probability(values.over), under = probability(values.under);
    return over >= under
      ? { line, side: 'Más de', probability: over, evidence: evidence(values.over) }
      : { line, side: 'Menos de', probability: under, evidence: evidence(values.under) };
  }).sort((a, b) => b.probability - a.probability)[0];
}

function TeamLogo({ team }) {
  const [failed, setFailed] = useState(false);
  const src = failed ? team?.fallbackLogo : (team?.logo || team?.fallbackLogo);
  if (!src) return <span className="ms-team-fallback">{String(team?.code || team?.name || '?').slice(0, 3).toUpperCase()}</span>;
  return <Image src={src} alt="" width={48} height={48} unoptimized onError={() => setFailed(true)} className="ms-team-logo" />;
}

function EvidenceTag({ value }) {
  if (!value || !value.n) return <span className="ms-evidence missing">Sin antecedentes</span>;
  return <span className="ms-evidence">{value.hits}/{value.n} cumplimientos</span>;
}

function ProbabilityLine({ label, entry, odd }) {
  const p = probability(entry);
  if (p == null) return null;
  const decimalOdd = Number(typeof odd === 'object' ? odd?.odd : odd);
  return (
    <div className="ms-prob-row">
      <div><strong>{label}</strong><EvidenceTag value={evidence(entry)} /></div>
      <div className="ms-prob-values"><b>{p}%</b>{Number.isFinite(decimalOdd) && decimalOdd > 1 ? <span>@{decimalOdd.toFixed(2)}</span> : null}</div>
    </div>
  );
}

function MatchCard({ game, timeZone, scoreLabel }) {
  const [open, setOpen] = useState(false);
  const analysis = game.analysis;
  const probabilities = analysis?.probabilities;
  const moneyline = probabilities?.moneyline;
  const total = bestTotal(probabilities);
  const isLive = game.status?.isLive || game.status?.short === 'LIVE';
  const isFinal = game.status?.isFinal || game.status?.short === 'FT';
  const bestOdds = analysis?.best_odds || {};
  const homeScore = game.scores?.home?.total;
  const awayScore = game.scores?.away?.total;
  return (
    <article className={`ms-match-card ${open ? 'open' : ''} ${isLive ? 'live' : ''}`}>
      <button type="button" className="ms-match-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <div className="ms-match-meta">
          <span>{game.league?.name || 'Liga'}</span>
          <span>{isLive ? 'EN VIVO' : isFinal ? 'FINAL' : gameTime(game.date, timeZone)}</span>
        </div>
        <div className="ms-score-grid">
          <div className="ms-team"><TeamLogo team={game.teams?.home} /><strong>{game.teams?.home?.name}</strong></div>
          <div className="ms-score">
            {(isLive || isFinal) && homeScore != null && awayScore != null
              ? <strong>{homeScore}<i>–</i>{awayScore}</strong>
              : <><span>{gameTime(game.date, timeZone)}</span><small>PRÓXIMO</small></>}
          </div>
          <div className="ms-team away"><TeamLogo team={game.teams?.away} /><strong>{game.teams?.away?.name}</strong></div>
        </div>
        <div className="ms-card-summary">
          {game.isAnalyzed && moneyline
            ? <><span>{game.teams.home.name} {probability(moneyline.home) ?? '—'}%</span><span>{game.teams.away.name} {probability(moneyline.away) ?? '—'}%</span></>
            : <span className="pending">Análisis estadístico pendiente</span>}
          <ChevronDown size={18} />
        </div>
      </button>
      <div className="ms-card-body" aria-hidden={!open}>
        <div>
          {!analysis ? (
            <div className="ms-empty-analysis"><BarChart3 size={22} /><span>El motor todavía no ha cerrado el análisis de este partido. No se inventará un porcentaje sin hechos.</span></div>
          ) : (
            <>
              <section className="ms-analysis-section">
                <h3>Ganador</h3>
                <ProbabilityLine label={game.teams.home.name} entry={moneyline?.home} odd={bestOdds?.moneyline?.home} />
                <ProbabilityLine label={game.teams.away.name} entry={moneyline?.away} odd={bestOdds?.moneyline?.away} />
                {moneyline?.draw && <ProbabilityLine label="Empate" entry={moneyline.draw} odd={bestOdds?.moneyline?.draw} />}
              </section>
              {total && (
                <section className="ms-analysis-section">
                  <h3>Mejor frecuencia del total</h3>
                  <ProbabilityLine label={`${total.side} ${total.line} ${scoreLabel}`} entry={{ probability: total.probability, evidence: total.evidence }} odd={bestOdds?.totals?.[total.line]?.[total.side === 'Más de' ? 'over' : 'under']} />
                </section>
              )}
              <section className="ms-analysis-section compact">
                <h3><ShieldCheck size={15} /> Trazabilidad</h3>
                <p>Temporada actual y archivo histórico se cuentan por separado. La actualidad domina; rival, localía y alineación solo ponderan partidos reales semejantes.</p>
                <div className="ms-engine-tags">
                  <span>Local: {probabilities?.engine?.samples?.homeTeam || 0} partidos</span>
                  <span>Visitante: {probabilities?.engine?.samples?.awayTeam || 0} partidos</span>
                  <span>{probabilities?.engine?.validation ? 'Validación fuera de muestra activa' : 'Validación acumulándose'}</span>
                </div>
              </section>
              {analysis.combinada?.selections?.length > 0 && (
                <section className="ms-analysis-section picks">
                  <h3><Sparkles size={15} /> Recomendaciones validadas</h3>
                  {analysis.combinada.selections.map((pick) => (
                    <div key={pick.id} className="ms-pick"><span>{pick.name}</span><b>{pick.probability}% · @{pick.odd}</b></div>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}

export default function MultisportDashboard({ sport, slug, title, subtitle, scoreLabel, accent = '#38bdf8' }) {
  const [timeZone, setTimeZone] = useState('UTC');
  const [date, setDate] = useState(() => dateInZone('UTC'));
  const [enqueueing, setEnqueueing] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const detected = detectTimeZone();
    setTimeZone(detected);
    setDate(dateInZone(detected));
  }, []);
  const key = `/api/sports/${slug}/fixtures?date=${date}&tz=${encodeURIComponent(timeZone)}`;
  const { data, error, isLoading, mutate } = useSWR(key, fetcher, { refreshInterval: 60_000, keepPreviousData: true, dedupingInterval: 15_000 });
  const { data: quota } = useSWR(`/api/sports/${slug}/quota`, fetcher, { refreshInterval: 300_000 });
  const games = data?.fixtures || [];

  usePusherEvent(`${sport}-live`, 'update', useCallback(() => { mutate(); }, [mutate]));
  const grouped = useMemo(() => {
    const map = new Map();
    for (const game of games) {
      const keyName = game.league?.name || title;
      if (!map.has(keyName)) map.set(keyName, []);
      map.get(keyName).push(game);
    }
    return [...map.entries()];
  }, [games, title]);

  const requestAnalysis = async () => {
    setEnqueueing(true); setMessage('');
    try {
      const response = await fetch(`/api/sports/${slug}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, force: true }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'No se pudo iniciar');
      setMessage('Análisis en marcha. La pantalla se actualizará automáticamente.');
      setTimeout(() => mutate(), 5000);
    } catch (requestError) { setMessage(requestError.message); }
    finally { setEnqueueing(false); }
  };

  return (
    <main className="ms-dashboard" style={{ '--ms-accent': accent }}>
      <header className="ms-hero">
        <div><span className="ms-eyebrow">MOTOR INDEPENDIENTE</span><h1>{title}</h1><p>{subtitle}</p></div>
        <div className="ms-provider"><ShieldCheck size={18} /><span>Datos verificables<br /><small>{sport === 'basketball' ? 'NBA oficial + API-NBA' : 'API-NFL'}</small></span></div>
      </header>
      <div className="ms-toolbar">
        <button onClick={() => setDate(shiftDay(date, -1))} aria-label="Día anterior"><ChevronLeft size={18} /></button>
        <div><CalendarDays size={16} /><strong>{dayLabel(date)}</strong></div>
        <button onClick={() => setDate(shiftDay(date, 1))} aria-label="Día siguiente"><ChevronRight size={18} /></button>
        <button className="ms-analyze-button" onClick={requestAnalysis} disabled={enqueueing}>
          <RefreshCw size={15} className={enqueueing ? 'spin' : ''} /> {enqueueing ? 'Iniciando' : 'Actualizar análisis'}
        </button>
      </div>
      <div className="ms-status-line">
        <span>{games.length} partidos</span>
        {quota?.providers?.nba && <span>Datos NBA: {quota.providers.nba.remaining}/{quota.providers.nba.limit}</span>}
        {quota?.providers?.basketball && <span>Cuotas: {quota.providers.basketball.remaining}/{quota.providers.basketball.limit}</span>}
        {quota && !quota.providers?.nba && <span>Cuota API: {quota.remaining}/{quota.limit}</span>}
        {message && <span>{message}</span>}
      </div>
      {isLoading && !games.length ? <DashboardBuffer compact /> : error ? <div className="ms-page-error">{error.message}</div> : grouped.length === 0 ? (
        <div className="ms-no-games"><CalendarDays size={30} /><strong>No hay partidos de {title} este día</strong></div>
      ) : grouped.map(([league, leagueGames]) => (
        <section key={league} className="ms-league"><h2>{league}<span>{leagueGames.length}</span></h2>{leagueGames.map((game) => <MatchCard key={game.id} game={game} timeZone={timeZone} scoreLabel={scoreLabel} />)}</section>
      ))}
    </main>
  );
}
