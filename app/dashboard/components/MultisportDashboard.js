'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import useSWR from 'swr';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import {
  BarChart3,
  ArrowRight,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Layers3,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { fetcher } from '../../../lib/fetcher';
import { usePusherEvent } from '../../../lib/use-pusher';
import DashboardBuffer from './DashboardBuffer';
import { DateCaption, LeaguePicker, StatusPicker } from './DashboardFilters';
import FinalVerdictPanel from './FinalVerdictPanel';
import { displayBettingText } from '../utils/display-betting-text';

function detectTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  catch { return 'UTC'; }
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
  try {
    return new Date(`${date}T12:00:00`).toLocaleDateString('es-ES', {
      weekday: 'short', day: 'numeric', month: 'short',
    });
  } catch { return date; }
}

function cardDate(value, timeZone) {
  try {
    return new Date(value).toLocaleDateString('es-ES', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone,
    });
  } catch { return ''; }
}

function displayProbability(value) {
  const probability = Math.max(0, Math.min(100, Number(value) || 0));
  if (probability >= 95) return 95;
  return Math.floor((probability + 1e-9) * 100) / 100;
}

function probability(entry) {
  const value = Number(entry?.probability ?? entry);
  return Number.isFinite(value) ? displayProbability(value) : null;
}

function engineRawProbability(entry) {
  const raw = Number(entry?.rawProbability);
  if (Number.isFinite(raw)) return raw * 100;
  const value = Number(entry?.probability ?? entry);
  return Number.isFinite(value) ? value : null;
}

function oddValue(entry) {
  const value = Number(typeof entry === 'object' ? entry?.odd : entry);
  return Number.isFinite(value) && value > 1 ? value : null;
}

function isGameLive(game) {
  return game.status?.isLive || ['LIVE', 'IN', 'Q1', 'Q2', 'Q3', 'Q4', 'OT', 'HT'].includes(game.status?.short);
}

function isGameFinal(game) {
  return game.status?.isFinal || ['FT', 'AOT', 'FINAL'].includes(game.status?.short);
}

function bestTotal(probabilities) {
  const candidates = [];
  for (const [line, values] of Object.entries(probabilities?.totals?.lines || {})) {
    const more = probability(values?.over);
    const less = probability(values?.under);
    if (more != null) candidates.push({ line, side: 'Más de', probability: more, rawProbability: engineRawProbability(values?.over), evidence: values.over?.evidence });
    if (less != null) candidates.push({ line, side: 'Menos de', probability: less, rawProbability: engineRawProbability(values?.under), evidence: values.under?.evidence });
  }
  return candidates.sort((left, right) => right.rawProbability - left.rawProbability)[0] || null;
}

function TeamLogo({ team }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [team?.logo, team?.fallbackLogo]);
  const src = failed ? team?.fallbackLogo : (team?.logo || team?.fallbackLogo);
  if (!src) {
    return <span className="ms-team-fallback">{String(team?.code || team?.name || '?').slice(0, 3).toUpperCase()}</span>;
  }
  return (
    <Image
      src={src}
      alt={`Escudo de ${team?.name || 'equipo'}`}
      width={48}
      height={48}
      unoptimized
      onError={() => setFailed(true)}
      className="ms-team-logo"
    />
  );
}

function EvidenceTag({ value }) {
  if (!value || !Number(value.n)) return <span className="ms-evidence missing">Sin historial registrado</span>;
  return <span className="ms-evidence">{Number(value.hits)}/{Number(value.n)} partidos cumplieron</span>;
}

function ProbabilityLine({ label, entry, odd }) {
  const percent = probability(entry);
  if (percent == null) return null;
  const decimalOdd = oddValue(odd);
  return (
    <div className="ms-prob-row">
      <div>
        <strong>{displayBettingText(label)}</strong>
        <EvidenceTag value={entry?.evidence} />
      </div>
      <div className="ms-prob-values">
        <b>{percent}%</b>
        {decimalOdd && <span>{decimalOdd.toFixed(2)}</span>}
      </div>
    </div>
  );
}

function PickButton({ pick, selected, onToggle }) {
  const reliability = Number(pick.reliability);
  return (
    <button
      type="button"
      className={`ms-pick-button ${selected ? 'is-selected' : ''}`}
      onClick={onToggle}
      aria-pressed={selected}
    >
      <span className="ms-pick-copy">
        <strong>{displayBettingText(pick.name)}</strong>
        <small>{pick.bookmakerSelection ? `Bet365 · ${displayBettingText(pick.bookmakerSelection)}` : 'Línea exacta disponible en Bet365'}</small>
      </span>
      <span className="ms-pick-metrics">
        <span><small>Prob.</small><b>{probability(pick)}%</b></span>
        {Number.isFinite(reliability) && <span><small>Fiab.</small><b>{reliability.toFixed(1)}%</b></span>}
        <span><small>Cuota</small><b>{oddValue(pick.odd)?.toFixed(2) || '—'}</b></span>
      </span>
    </button>
  );
}

const EMPTY_SELECTED_PICKS = Object.freeze({});

const MatchCard = memo(function MatchCard({ game, timeZone, scoreLabel, slug, expanded, onToggle, selectedPicks, onTogglePick }) {
  const analysis = game.analysis;
  const probabilities = analysis?.probabilities;
  const moneyline = probabilities?.moneyline;
  const total = bestTotal(probabilities);
  const live = isGameLive(game);
  const final = isGameFinal(game);
  const bestOdds = analysis?.best_odds || {};
  const homeScore = game.scores?.home?.total;
  const awayScore = game.scores?.away?.total;
  const picks = (analysis?.combinada?.selectable || analysis?.combinada?.selections || [])
    .filter((pick) => probability(pick) != null && oddValue(pick.odd) != null);
  const homeProbability = probability(moneyline?.home);
  const awayProbability = probability(moneyline?.away);
  const homeSamples = Number(probabilities?.engine?.samples?.homeTeam || 0);
  const awaySamples = Number(probabilities?.engine?.samples?.awayTeam || 0);

  return (
    <article className={`mcard ms-match-card ${expanded ? 'open done' : 'done'} ${live ? 'live' : ''} ${final ? 'fin' : ''}`}>
      <button type="button" className="ms-match-head" onClick={() => onToggle(game.id)} aria-expanded={expanded}>
        <div className="ms-match-meta">
          <span>{game.league?.name || 'Competición'}</span>
          <span>{cardDate(game.date, timeZone)}</span>
        </div>

        <div className="ms-score-grid">
          <div className="ms-team">
            <TeamLogo team={game.teams?.home} />
            <strong>{game.teams?.home?.name}</strong>
          </div>
          <div className="ms-score">
            {live || final ? (
              <>
                <small className={live ? 'is-live' : ''}>{live ? 'EN VIVO' : 'FINALIZADO'}</small>
                <strong>{homeScore ?? '—'}<i>–</i>{awayScore ?? '—'}</strong>
              </>
            ) : (
              <>
                <span>{gameTime(game.date, timeZone)}</span>
                <small>PRÓXIMO</small>
              </>
            )}
          </div>
          <div className="ms-team away">
            <TeamLogo team={game.teams?.away} />
            <strong>{game.teams?.away?.name}</strong>
          </div>
        </div>

        <div className="ms-card-summary">
          {game.isAnalyzed && (homeProbability != null || awayProbability != null) ? (
            <span className="ms-summary-probabilities">
              {homeProbability != null && <b>{game.teams.home.name} {homeProbability}%</b>}
              {awayProbability != null && <b>{game.teams.away.name} {awayProbability}%</b>}
            </span>
          ) : (
            <span className="pending">Análisis en preparación</span>
          )}
          {Object.keys(selectedPicks).length > 0 && <span className="ms-selected-count">{Object.keys(selectedPicks).length} elegidas</span>}
          <ChevronDown size={18} aria-hidden="true" />
        </div>
      </button>

      <div className="ms-card-body" aria-hidden={!expanded}>
        <div>
          {!analysis ? (
            <div className="ms-empty-analysis">
              <BarChart3 size={22} aria-hidden="true" />
              <span>La recomendación aparecerá cuando estén procesados los datos disponibles de este partido.</span>
            </div>
          ) : (
            <>
              <details className="ms-sub-accordion" open>
                <summary><Layers3 size={16} aria-hidden="true" /><span>Arma tu combinada</span><small>{picks.length} opciones</small></summary>
                <section className="ms-analysis-section picks">
                  {picks.length > 0 ? (
                    <div className="ms-pick-list">
                      {picks.map((pick) => (
                        <PickButton
                          key={pick.id}
                          pick={pick}
                          selected={Boolean(selectedPicks[pick.id])}
                          onToggle={() => onTogglePick(game, pick)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="ms-empty-market">
                      Bet365 no tiene ahora una línea exacta compatible con el cálculo, probabilidad mínima del 65% y cuota mínima de 1,20.
                    </div>
                  )}
                </section>
              </details>

              <details className="ms-sub-accordion">
                <summary><BarChart3 size={16} aria-hidden="true" /><span>Frecuencias calculadas</span></summary>
                <section className="ms-analysis-section">
                  <h3>Probabilidad de resultado</h3>
                  <ProbabilityLine label={`${game.teams.home.name} gana`} entry={moneyline?.home} odd={bestOdds?.moneyline?.home} />
                  <ProbabilityLine label={`${game.teams.away.name} gana`} entry={moneyline?.away} odd={bestOdds?.moneyline?.away} />
                  {moneyline?.draw && <ProbabilityLine label="Empate" entry={moneyline.draw} odd={bestOdds?.moneyline?.draw} />}
                </section>

                {total && (
                  <section className="ms-analysis-section">
                    <h3>Mejor frecuencia de anotación</h3>
                    <ProbabilityLine
                      label={`${total.side} ${total.line} ${scoreLabel}`}
                      entry={{ probability: total.probability, evidence: total.evidence }}
                      odd={bestOdds?.totals?.[total.line]?.[total.side === 'Más de' ? 'over' : 'under']}
                    />
                  </section>
                )}

                <section className="ms-analysis-section compact">
                  <h3><ShieldCheck size={15} aria-hidden="true" /> Cómo llega a estos porcentajes</h3>
                  <p>Se cuentan resultados reales y la temporada actual tiene más peso que el historial anterior. Rival, localía y jugadores disponibles solo ponderan partidos registrados semejantes.</p>
                  <div className="ms-evidence-summary">
                    <span>{game.teams.home.name}: {homeSamples} partidos</span>
                    <span>{game.teams.away.name}: {awaySamples} partidos</span>
                  </div>
                </section>
              </details>

              <FinalVerdictPanel
                verdict={analysis?.analysis?.finalVerdict}
                homeName={game.teams.home.name}
                awayName={game.teams.away.name}
                compact
              />

              <Link className="ms-view-full" href={`/dashboard/${slug}/analisis/${encodeURIComponent(game.id)}`}>
                <span><small>Explora cada mercado y periodo</small><strong>Ver análisis completo</strong></span>
                <ArrowRight size={18} aria-hidden="true" />
              </Link>
            </>
          )}
        </div>
      </div>
    </article>
  );
});

function CombinedBet({ combination, onRemove, onClear }) {
  if (!combination) {
    return (
      <div className="empty-state fade-in">
        <div className="empty-icon"><Layers3 size={28} aria-hidden="true" /></div>
        <h3>Combinada vacía</h3>
        <p>Abre un partido analizado y selecciona las recomendaciones que quieras combinar.</p>
      </div>
    );
  }

  return (
    <div className="comb-builder fade-in">
      <div className="comb-hero">
        <span className="comb-hero-icon"><Layers3 size={21} aria-hidden="true" /></span>
        <span><small>Constructor inteligente</small><strong>Tu combinada</strong></span>
        <span className="comb-count">{combination.selections.length} selecciones</span>
      </div>
      <div className="comb-list">
        {combination.selections.map((selection, index) => (
          <article key={`${selection.fixtureId}-${selection.id}`} className="comb-item">
            <span className="comb-item-index">{String(index + 1).padStart(2, '0')}</span>
            <div className="comb-item-content">
              <div className="comb-item-match">{selection.matchName}</div>
              <span className="comb-item-name">{displayBettingText(selection.name)}</span>
            </div>
            <div className="comb-item-metrics">
              <span className={`comb-item-prob ${Number(selection.rawProbability ?? selection.probability) >= 75 ? 'high' : Number(selection.rawProbability ?? selection.probability) >= 50 ? 'mid' : 'low'}`}>
                <small>Prob.</small>{displayProbability(selection.rawProbability ?? selection.probability)}%
              </span>
              <span className="comb-item-odd"><small>Cuota</small>{selection.odd.toFixed(2)}</span>
            </div>
            <button type="button" className="comb-item-rm" onClick={() => onRemove(selection.fixtureId, selection.id)} aria-label={`Quitar ${displayBettingText(selection.name)}`}>
              <X size={15} aria-hidden="true" />
            </button>
          </article>
        ))}
      </div>
      <div className="comb-summary">
        <div className="comb-sum-row"><span>Cuota total</span><strong className="comb-odd-total">{combination.combinedOdd.toFixed(2)}</strong></div>
        <div className="comb-sum-row"><span>Probabilidad conjunta</span><strong className={combination.combinedProbability >= 60 ? 'safe' : 'danger'}>{displayProbability(combination.combinedProbability)}%</strong></div>
      </div>
      <div className="comb-actions">
        <button type="button" className="btn-clear" onClick={onClear}>Limpiar combinada</button>
      </div>
    </div>
  );
}

export default function MultisportDashboard({ sport, slug, title, scoreLabel }) {
  const [timeZone, setTimeZone] = useState('UTC');
  const [timeZoneReady, setTimeZoneReady] = useState(false);
  const [date, setDate] = useState(() => dateInZone('UTC'));
  const [tab, setTab] = useState('partidos');
  const [statusFilter, setStatusFilter] = useState('all');
  const [leagueFilter, setLeagueFilter] = useState('');
  const [expandedMatch, setExpandedMatch] = useState(null);
  const [selectedMarkets, setSelectedMarkets] = useState({});
  const [enqueueing, setEnqueueing] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const detected = detectTimeZone();
    setTimeZone(detected);
    setDate(dateInZone(detected));
    setTimeZoneReady(true);
  }, []);

  const key = timeZoneReady ? `/api/sports/${slug}/fixtures?date=${date}&tz=${encodeURIComponent(timeZone)}` : null;
  const { data, error, isLoading, isValidating, mutate } = useSWR(key, fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
    keepPreviousData: true,
    dedupingInterval: 15_000,
  });
  const currentData = data?.date === date ? data : null;
  const games = currentData?.fixtures || [];
  const competitions = currentData?.competitions || [];

  usePusherEvent(`${sport}-live`, 'update', useCallback(() => { mutate(); }, [mutate]));

  const changeDate = useCallback((nextDate) => {
    if (!nextDate || nextDate === date) return;
    setDate(nextDate);
    setExpandedMatch(null);
    setSelectedMarkets({});
    setMessage('');
  }, [date]);

  const leagues = useMemo(() => competitions.map((competition) => ({
    id: competition.id,
    name: competition.name,
    country: competition.country,
  })), [competitions]);

  const leagueGames = useMemo(() => games.filter((game) => (
    !leagueFilter || String(game.league?.id) === String(leagueFilter)
  )), [games, leagueFilter]);

  const counts = useMemo(() => ({
    all: leagueGames.length,
    live: leagueGames.filter(isGameLive).length,
    upcoming: leagueGames.filter((game) => !isGameLive(game) && !isGameFinal(game)).length,
    finished: leagueGames.filter(isGameFinal).length,
  }), [leagueGames]);

  const visibleGames = useMemo(() => leagueGames.filter((game) => {
    if (statusFilter === 'live') return isGameLive(game);
    if (statusFilter === 'upcoming') return !isGameLive(game) && !isGameFinal(game);
    if (statusFilter === 'finished') return isGameFinal(game);
    return true;
  }), [leagueGames, statusFilter]);

  const rows = useMemo(() => {
    const output = [];
    let previousLeague = null;
    const leagueCounts = new Map();
    for (const game of visibleGames) {
      const leagueId = String(game.league?.id || game.league?.name || 'competition');
      leagueCounts.set(leagueId, (leagueCounts.get(leagueId) || 0) + 1);
    }
    for (const game of [...visibleGames].sort((left, right) => {
      const leagueOrder = String(left.league?.name || '').localeCompare(String(right.league?.name || ''), 'es');
      return leagueOrder || new Date(left.date) - new Date(right.date);
    })) {
      const leagueId = String(game.league?.id || game.league?.name || 'competition');
      if (leagueId !== previousLeague) {
        output.push({ type: 'league', key: `league-${leagueId}`, league: game.league, count: leagueCounts.get(leagueId) || 0 });
        previousLeague = leagueId;
      }
      output.push({ type: 'game', key: `game-${game.id}`, game });
    }
    return output;
  }, [visibleGames]);

  const combination = useMemo(() => {
    const selections = Object.entries(selectedMarkets).flatMap(([fixtureId, entries]) => (
      Object.values(entries).map((entry) => ({ ...entry, fixtureId }))
    ));
    if (!selections.length) return null;
    const combinedOdd = selections.reduce((total, selection) => total * selection.odd, 1);
    const combinedProbability = selections.reduce((total, selection) => total * (Number(selection.rawProbability ?? selection.probability) / 100), 1) * 100;
    return {
      selections,
      combinedOdd,
      combinedProbability: Math.round((combinedProbability + Number.EPSILON) * 100) / 100,
    };
  }, [selectedMarkets]);

  const totalSelections = combination?.selections.length || 0;
  const pendingGames = useMemo(() => games.filter((game) => !game.isAnalyzed).length, [games]);

  const toggleExpanded = useCallback((gameId) => {
    setExpandedMatch((current) => current === gameId ? null : gameId);
  }, []);

  const togglePick = useCallback((game, pick) => {
    setSelectedMarkets((previous) => {
      const fixtureId = String(game.id);
      const fixtureSelections = { ...(previous[fixtureId] || {}) };
      if (fixtureSelections[pick.id]) delete fixtureSelections[pick.id];
      else {
        fixtureSelections[pick.id] = {
          ...pick,
          probability: probability(pick),
          odd: oddValue(pick.odd),
          matchName: `${game.teams.home.name} vs ${game.teams.away.name}`,
        };
      }
      const next = { ...previous };
      if (Object.keys(fixtureSelections).length) next[fixtureId] = fixtureSelections;
      else delete next[fixtureId];
      return next;
    });
  }, []);

  const removePick = useCallback((fixtureId, pickId) => {
    setSelectedMarkets((previous) => {
      const fixtureSelections = { ...(previous[fixtureId] || {}) };
      delete fixtureSelections[pickId];
      const next = { ...previous };
      if (Object.keys(fixtureSelections).length) next[fixtureId] = fixtureSelections;
      else delete next[fixtureId];
      return next;
    });
  }, []);

  const requestAnalysis = async () => {
    setEnqueueing(true);
    setMessage('');
    try {
      const response = await fetch(`/api/sports/${slug}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, force: true }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'No se pudo preparar la jornada');
      setMessage('La jornada se está preparando. Los resultados aparecerán automáticamente.');
      setTimeout(() => mutate(), 5000);
    } catch (requestError) {
      setMessage(requestError.message || 'No se pudo preparar la jornada');
    } finally {
      setEnqueueing(false);
    }
  };

  const listRef = useRef(null);
  const [listOffset, setListOffset] = useState(0);
  const virtualizer = useWindowVirtualizer({
    count: tab === 'partidos' ? rows.length : 0,
    estimateSize: (index) => rows[index]?.type === 'league' ? 44 : (expandedMatch === rows[index]?.game?.id ? 650 : 210),
    overscan: 6,
    scrollMargin: listOffset,
    getItemKey: (index) => rows[index]?.key || index,
    shouldAdjustScrollPositionOnItemSizeChange: () => false,
  });

  useEffect(() => {
    if (tab !== 'partidos' || !listRef.current) return undefined;
    const updateOffset = () => {
      if (!listRef.current) return;
      const next = listRef.current.getBoundingClientRect().top + window.scrollY;
      setListOffset((previous) => Math.abs(previous - next) > 1 ? next : previous);
    };
    const frame = requestAnimationFrame(updateOffset);
    window.addEventListener('resize', updateOffset, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', updateOffset);
    };
  }, [tab, rows.length, pendingGames, message]);

  const loading = !currentData && (isLoading || isValidating || !timeZoneReady);

  return (
    <div className="app app-fade-in ms-sport-app">
      <div className="container">
        <div className="controls-row">
          <div className="date-nav">
            <button className="date-arrow" onClick={() => changeDate(shiftDay(date, -1))} aria-label="Día anterior">
              <ChevronLeft size={17} aria-hidden="true" />
            </button>
            <label className="date-picker-label">
              <DateCaption isToday={date === dateInZone(timeZone)} label={dayLabel(date)} />
              <input
                type="date"
                value={date}
                onChange={(event) => changeDate(event.target.value)}
                aria-label="Elegir fecha"
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
              />
            </label>
            <button className="date-arrow" onClick={() => changeDate(shiftDay(date, 1))} aria-label="Día siguiente">
              <ChevronRight size={17} aria-hidden="true" />
            </button>
            {date !== dateInZone(timeZone) && (
              <button className="date-today" onClick={() => changeDate(dateInZone(timeZone))}>
                <CalendarDays size={14} aria-hidden="true" /> Hoy
              </button>
            )}
          </div>
          <div className="filters-row">
            <LeaguePicker leagues={leagues} value={leagueFilter} onChange={setLeagueFilter} />
          </div>
        </div>

        <div className="tabs">
          <button className={`tab ${tab === 'partidos' ? 'active' : ''}`} onClick={() => setTab('partidos')}>
            Partidos
            {counts.all > 0 && <span className="tab-badge">{counts.all}</span>}
          </button>
          <button className={`tab ${tab === 'combinada' ? 'active' : ''}`} onClick={() => setTab('combinada')}>
            Combinada
            {totalSelections > 0 && <span className="tab-badge">{totalSelections}</span>}
          </button>
          <StatusPicker value={statusFilter} onChange={setStatusFilter} counts={counts} includeFavorites={false} />
        </div>

        {message && <div className="batch-banner fade-in" role="status">{message}</div>}
        {error && games.length > 0 && <div className="warn fade-in">No se pudo actualizar la jornada. Se muestran los últimos datos disponibles.</div>}

        {loading ? (
          <DashboardBuffer compact />
        ) : error && !games.length ? (
          <div className="empty-state fade-in">
            <div className="empty-icon">⚡</div>
            <h3>No se pudo cargar la jornada</h3>
            <p>Comprueba tu conexión e inténtalo de nuevo.</p>
            <button className="btn-primary" onClick={() => mutate()}>Reintentar</button>
          </div>
        ) : tab === 'combinada' ? (
          <CombinedBet combination={combination} onRemove={removePick} onClear={() => setSelectedMarkets({})} />
        ) : visibleGames.length === 0 ? (
          <div className="empty-state fade-in">
            <div className="empty-icon"><CalendarDays size={30} aria-hidden="true" /></div>
            <h3>Sin partidos</h3>
            <p>No hay partidos de {title} para esta fecha y filtro.</p>
          </div>
        ) : (
          <div
            ref={listRef}
            className="match-list match-list-virtual ms-virtual-list"
            style={{ position: 'relative', display: 'block', height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;
              return (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  className="ms-virtual-row"
                  style={{
                    position: 'absolute', top: 0, left: 0, width: '100%',
                    paddingBottom: row.type === 'league' ? 4 : 8,
                    boxSizing: 'border-box',
                    transform: `translateY(${virtualRow.start - listOffset}px)`,
                  }}
                >
                  {row.type === 'league' ? (
                    <div className="ms-league-heading">
                      <span>{row.league?.name || title}</span>
                      <small>{row.count} {row.count === 1 ? 'partido' : 'partidos'}</small>
                    </div>
                  ) : (
                    <MatchCard
                      game={row.game}
                      timeZone={timeZone}
                      scoreLabel={scoreLabel}
                      slug={slug}
                      expanded={expandedMatch === row.game.id}
                      onToggle={toggleExpanded}
                      selectedPicks={selectedMarkets[String(row.game.id)] || EMPTY_SELECTED_PICKS}
                      onTogglePick={togglePick}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {tab === 'partidos' && pendingGames > 0 && games.length > 0 && (
          <div className="ms-refresh-row">
            <span>{pendingGames} {pendingGames === 1 ? 'partido pendiente' : 'partidos pendientes'} de análisis</span>
            <button type="button" onClick={requestAnalysis} disabled={enqueueing}>
              <RefreshCw size={15} className={enqueueing ? 'spin' : ''} aria-hidden="true" />
              {enqueueing ? 'Preparando…' : 'Preparar jornada'}
            </button>
          </div>
        )}

        {tab === 'partidos' && totalSelections > 0 && (
          <div className="float-bar float-bar-combinada slide-up">
            <button className="btn-comb-float" onClick={() => setTab('combinada')}>
              <span className="float-comb-icon"><Layers3 size={19} aria-hidden="true" /></span>
              <span><small>Tu selección</small><strong>Ver combinada · {totalSelections}</strong></span>
              {combination && <span className="float-odd">{combination.combinedOdd.toFixed(2)}x</span>}
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
