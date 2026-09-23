'use client';

import { useState } from 'react';
import { ArrowRight, BarChart3, EyeOff, Flag, Layers3, RotateCcw, Scale, TriangleAlert, X } from 'lucide-react';
import { HorizontalChoiceBar, MatchHeadCard, MatchFullscreen } from '../page';
import { FreeRecommendations, LockedAnalysis } from './FreeAccessProvider';
import BaseballResultStats from '../baseball/components/BaseballResultStats';
import FinalVerdictPanel from './FinalVerdictPanel';
import MarketOutcomeBadge from './MarketOutcomeBadge';
import PredictionSealBadge from './PredictionSealBadge';
import { marketResultState, settleMarketSelection } from '../../../lib/market-settlement';
import { displayBettingText } from '../utils/display-betting-text';

const percent = entry => {
  if (entry == null) return null;
  const value = typeof entry === 'object' ? (entry.rawProbability != null ? Number(entry.rawProbability) * 100 : Number(entry.probability)) : Number(entry);
  return Number.isFinite(value) ? Math.min(95, Math.floor(value * 100) / 100) : null;
};
const probabilityText = value => value == null ? '—' : `${value}%`;

export function SportFrequencies({ probabilities, home, away, scoreLabel = 'puntos' }) {
  const [active, setActive] = useState('score');
  const p = probabilities?.evidence || probabilities;
  if (!p) return <p className="free-empty">Las frecuencias aparecerán cuando termine el análisis.</p>;
  const groups = [{ key: 'score', label: scoreLabel === 'carreras' ? 'Carreras' : 'Puntos', color: '#4ade80' },
    ...Object.entries(p.statistics || {}).map(([key, value]) => ({ key, label: value.label || key, color: '#fbbf24' })),
    ...Object.entries(p.periods || {}).map(([key, value]) => ({ key: `period-${key}`, label: value.label || ({ firstHalf: 'Primera mitad', secondHalf: 'Segunda mitad', quarter1: 'Primer cuarto', quarter2: 'Segundo cuarto', quarter3: 'Tercer cuarto', quarter4: 'Cuarto cuarto' })[key] || key, color: '#22d3ee' }))];
  const resolved = groups.some(group => group.key === active) ? active : 'score';
  const selected = resolved.startsWith('period-') ? p.periods[resolved.slice(7)] : resolved === 'score' ? p : p.statistics[resolved];
  const isScore = resolved === 'score' || resolved.startsWith('period-');
  const label = isScore ? scoreLabel : selected.label || resolved;
  const ladders = isScore ? [['Total del partido', selected.displayFrequencies?.totals || selected.totals?.lines || selected.totals], [home, selected.displayFrequencies?.home || selected.teamTotals?.home], [away, selected.displayFrequencies?.away || selected.teamTotals?.away]]
    : [['Total del partido', selected.total], [home, selected.home], [away, selected.away]];
  return <div className="analysis-tab-stack">
    <HorizontalChoiceBar items={groups} active={resolved} onChange={setActive} label="Filtrar frecuencias calculadas" variant="filters" />
    <p className="probability-explainer">Cada porcentaje cuenta antecedentes comparables que superaron o quedaron por debajo de la línea. Los empates con una línea entera se contabilizan aparte.</p>
    <div className="subacc-data-grid">{ladders.map(([title, lines]) => <article key={title} className="subacc-data-card"><h4>{title} · {label}</h4>
      {Object.entries(lines || {}).sort((a, b) => Number(a[0]) - Number(b[0])).map(([line, values]) => <div key={line} className="sport-frequency-pair">{['over', 'under'].map(side => <div key={side} className="sport-frequency-row"><span>{side === 'over' ? 'Más' : 'Menos'} de {line}</span><strong>{probabilityText(percent(values?.[side]))}</strong></div>)}</div>)}
    </article>)}</div>
    {isScore && selected.moneyline && <div className="subacc-data-card"><h4>Resultado</h4>{[['home', home], ['draw', 'Empate'], ['away', away]].filter(([side]) => selected.moneyline[side] != null).map(([side, name]) => <div key={side} className="sport-frequency-row"><span>{name}</span><strong>{probabilityText(percent(selected.moneyline[side]))}</strong></div>)}</div>}
  </div>;
}

export function SportAnalysisTabs({ game, sport, scoreLabel, selected = {}, onToggle = () => {}, onViewFull }) {
  const [active, setActive] = useState('markets');
  const analysis = game.analysis;
  const free = analysis?.access === 'free';
  const picks = analysis?.combinada?.selectable || analysis?.combinada?.selections || [];
  const tabs = [
    { key: 'markets', label: 'Mercados para tu combinada', icon: Layers3, color: '#5ee6b1' },
    { key: 'stats', label: 'Estadísticas calculadas', icon: Scale, color: '#f97316' },
    { key: 'probs', label: 'Frecuencias calculadas', icon: BarChart3, color: '#2dd4bf' },
    { key: 'verdict', label: 'Veredicto final', icon: Flag, color: '#f5e400' },
    ...(free ? [{ key: 'full', label: 'Análisis completo', icon: BarChart3, color: '#bce1ab' }] : []),
  ];
  const prediction = analysis?.probabilities?.evidence || analysis?.probabilities;
  return <div className="acc-content open"><div className="acc-inner">
    <HorizontalChoiceBar items={tabs} active={active} onChange={setActive} label="Secciones del análisis" idPrefix={`sport-${sport}-${game.id}`} />
    <section className="analysis-tab-panel" role="tabpanel" id={`sport-${sport}-${game.id}-panel-${active}`} aria-labelledby={`sport-${sport}-${game.id}-tab-${active}`}>
      {free ? active === 'markets' ? <FreeRecommendations preview={analysis.freePreview} selected={selected} onToggle={onToggle} /> : <LockedAnalysis title={tabs.find(t => t.key === active).label} />
        : active === 'markets' ? <div className="markets"><div className="markets-grid">{picks.map(pick => {
          const probability = Math.min(95, Math.floor(Number(pick.rawProbability ?? pick.probability) * 100) / 100);
          const state = marketResultState({ sport, game, liveResult: game.liveResult });
          return <button className={`mkt ${selected[pick.id] ? 'on' : ''} ${probability >= 75 ? 'hi' : 'md'}`} key={pick.id} onClick={() => onToggle(pick)}>
            <span className="mkt-name">{displayBettingText(pick.name || pick.pick)}</span><span className="mkt-validation is-validated">Recomendación estadística</span><PredictionSealBadge seal={pick.seal} />
            <MarketOutcomeBadge outcome={settleMarketSelection({ sport, selection: pick, game, liveResult: game.liveResult })} pendingLabel={state.isLive ? 'En juego' : state.isFinal ? 'Pendiente oficial' : null} compact />
            <div className="mkt-bar"><div className="mkt-fill" style={{ width: `${probability}%` }} /></div><div className="mkt-nums"><span className="mkt-pct">{probability}%</span>{pick.odd && <span className="mkt-odd">{Number(pick.odd).toFixed(2)}</span>}{pick.reliability != null && <small>Fiab. {Number(pick.reliability).toFixed(1)}%</small>}<span className="mkt-bk">{pick.bookmaker}</span></div>
          </button>;
        })}</div>{!picks.length && <p className="free-empty">Todavía no hay opciones que cumplan los criterios de recomendación.</p>}</div>
        : active === 'probs' ? <SportFrequencies probabilities={analysis?.probabilities} home={game.teams.home.name} away={game.teams.away.name} scoreLabel={scoreLabel} />
        : active === 'verdict' ? <FinalVerdictPanel verdict={analysis?.analysis?.finalVerdict} homeName={game.teams.home.name} awayName={game.teams.away.name} compact embedded />
        : <><div className="subacc-data-grid">{[['Local', prediction?.expected?.home], ['Total', prediction?.expected?.total], ['Visitante', prediction?.expected?.away]].map(([name, value]) => <article key={name} className="analysis-stat-card"><h4>{name} · {scoreLabel}</h4><div className="analysis-stat-row"><span>Media calculada</span><strong>{value == null ? '—' : Number(value).toFixed(2)}</strong></div></article>)}</div>{sport === 'baseball' && <><div className="subacc-data-grid">{['home', 'away'].map(side => { const pitcher = analysis?.analysis?.pitcherMatchup?.[side]; return <article key={side} className="analysis-stat-card"><h4>{game.teams[side].name}</h4><p>{pitcher?.name || game.probablePitchers?.[side]?.name || 'Abridor por confirmar'}</p><div className="analysis-stat-row"><span>ERA</span><strong>{pitcher?.stats?.era ?? '—'}</strong></div><div className="analysis-stat-row"><span>Probabilidad de ganar</span><strong>{probabilityText(percent(analysis?.combinada?.winProbabilities?.[side]))}</strong></div></article>; })}</div><BaseballResultStats result={game.liveResult} homeName={game.teams.home.name} awayName={game.teams.away.name} /></>}</>}
    </section>
    {onViewFull && <button className="btn-full" onClick={onViewFull}><span><small>Explora cada indicador</small><strong>Ver análisis completo</strong></span><ArrowRight size={18} /></button>}
  </div></div>;
}

export default function SharedSportCard({ game, sport, scoreLabel, timeZone, expanded, onToggle, selected, onTogglePick, favorite, onFavorite, onDismiss, onViewFull, onStep }) {
  const rawStatus = game.status?.short || 'NS';
  const finished = ['FT', 'AOT', 'FINAL'].includes(rawStatus);
  const live = !finished && (/^IN\d*$/.test(rawStatus) || ['LIVE', 'HT', 'Q1', 'Q2', 'Q3', 'Q4'].includes(rawStatus));
  const status = { ...game.status, short: finished ? 'FT' : live ? '1H' : rawStatus };
  const match = { fixture: { id: game.id, date: game.date, status }, league: game.league || {}, teams: game.teams,
    goals: { home: game.scores?.home?.total ?? game.liveResult?.home_score, away: game.scores?.away?.total ?? game.liveResult?.away_score } };
  // liveResult trae la caja de béisbol; basketball/NFL exponen los cuartos
  // como game.periods (top-level), no anidados — se combinan las dos formas.
  const cardLiveStats = { ...(game.liveResult || {}), periods: game.periods || game.liveResult?.periods || null };
  const head = <div className="acc-head" onClick={onToggle}><MatchHeadCard sport={sport} match={match} userTz={timeZone} isFavorite={favorite} liveStats={cardLiveStats}
    onFavorite={onFavorite ? () => onFavorite(game.id) : null} onDismiss={onDismiss} />{!expanded && <div className="acc-indicator"><span className="chev-ico">▾</span></div>}</div>;
  return <><div className="acc-card">{head}</div>{expanded && <MatchFullscreen onStep={onStep} head={head} body={game.analysis
    ? <SportAnalysisTabs game={game} sport={sport} scoreLabel={scoreLabel} selected={selected} onToggle={onTogglePick} onViewFull={onViewFull} />
    : <p className="free-empty">El análisis se está preparando automáticamente.</p>} />}</>;
}

// Confirmación antes de ocultar un partido — el click en la X abre esto en
// vez de ocultar directo (se ocultaban partidos por error sin poder deshacer).
// Compartido por fútbol y béisbol (el mismo botón X de MatchHeadCard).
export function DismissConfirmDialog({ fixture, onCancel, onConfirm }) {
  const home = fixture?.teams?.home?.name || 'este partido';
  const away = fixture?.teams?.away?.name;
  return (
    <div className="confirm-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="confirm-modal-dialog" role="alertdialog" aria-modal="true" aria-labelledby="dismiss-confirm-title">
        <span className="confirm-modal-icon"><TriangleAlert size={22} aria-hidden="true" /></span>
        <h2 id="dismiss-confirm-title">¿Ocultar este partido?</h2>
        <p>{away ? <>Vas a ocultar <strong>{home} vs {away}</strong> de tu lista.</> : <>Vas a ocultar <strong>{home}</strong> de tu lista.</>} Podés recuperarlo después desde &quot;Ocultos&quot;.</p>
        <div className="confirm-modal-actions">
          <button type="button" className="confirm-modal-cancel" onClick={onCancel}>Cancelar</button>
          <button type="button" className="confirm-modal-confirm" onClick={onConfirm}>Ocultar</button>
        </div>
      </div>
    </div>
  );
}

// Panel para ver y recuperar (des-ocultar) partidos previamente ocultados.
export function HiddenFixturesPanel({ fixtures, userTz, onUnhide, onClose }) {
  const tz = userTz || 'UTC';
  return (
    <div className="confirm-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="hidden-panel-dialog" role="dialog" aria-modal="true" aria-labelledby="hidden-panel-title">
        <button type="button" className="hidden-panel-close" onClick={onClose} aria-label="Cerrar"><X size={18} aria-hidden="true" /></button>
        <h2 id="hidden-panel-title"><EyeOff size={18} aria-hidden="true" /> Partidos ocultos</h2>
        {fixtures.length === 0
          ? <p className="hidden-panel-empty">No tenés partidos ocultos hoy.</p>
          : (
            <ul className="hidden-panel-list">
              {fixtures.map((f) => (
                <li key={f.fixture.id} className="hidden-panel-item">
                  <div className="hidden-panel-teams">
                    <span>{f.teams.home.name} vs {f.teams.away.name}</span>
                    <small>{new Date(f.fixture.date).toLocaleString('es', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>
                  </div>
                  <button type="button" className="hidden-panel-restore" onClick={() => onUnhide(f.fixture.id)}>
                    <RotateCcw size={14} aria-hidden="true" /> Recuperar
                  </button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  );
}
