'use client';
import { useFreeAccess, LockedAnalysis } from './FreeAccessProvider';
import { SportAnalysisTabs } from './SharedSportAnalysis';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import DashboardBuffer from './DashboardBuffer';
import FinalVerdictPanel from './FinalVerdictPanel';
import { displayBettingText } from '../utils/display-betting-text';

const PERIOD_LABELS = Object.freeze({
  firstHalf: 'Primera mitad', secondHalf: 'Segunda mitad', quarter1: 'Primer cuarto', quarter2: 'Segundo cuarto',
  quarter3: 'Tercer cuarto', quarter4: 'Cuarto cuarto', first3: 'Primeras 3 entradas', first4_5: 'Primeras 4,5 entradas',
  first5: 'Primeras 5 entradas', first7: 'Primeras 7 entradas',
});

const normalizedBookmaker = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');
const probability = (entry) => {
  const raw = Number(entry?.rawProbability);
  if (Number.isFinite(raw)) return raw <= 1 ? raw * 100 : raw;
  const value = Number(entry?.probability ?? entry);
  return Number.isFinite(value) ? value : null;
};
const pct = (entry) => {
  const value = probability(entry);
  return value == null ? '—' : `${Math.min(95, value).toFixed(2).replace(/\.00$/, '')}%`;
};
const fmt = (value) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2);
const validMarket = (market) => normalizedBookmaker(market?.bookmaker) === 'bet365'
  && Number(market?.odd) >= 1.2 && Number(market?.rawProbability ?? market?.probability) >= 65;

function Section({ title, children }) {
  return <section className="msa-section"><h2>{title}</h2>{children}</section>;
}

function ProbabilityPill({ label, value }) {
  if (probability(value) == null) return null;
  return <span className="msa-pill"><small>{label}</small><b>{pct(value)}</b></span>;
}

// Malla simétrica (línea + más%/menos%) en vez de la lista vertical infinita.
function Mesh({ lines, label = 'puntos' }) {
  const entries = Object.entries(lines || {}).sort((left, right) => Number(left[0]) - Number(right[0]));
  if (!entries.length) return null;
  return (
    <div className="msa-mesh">
      {entries.map(([line, values]) => (
        <div key={line} className="msa-mesh-cell">
          <strong>{line} {label}</strong>
          <span className="over">Más {pct(values?.over)}</span>
          <span className="under">Menos {pct(values?.under)}</span>
        </div>
      ))}
    </div>
  );
}

// Una sola tarjeta por estadística: línea a la izquierda, columna por equipo
// con su porcentaje a la derecha, en vez de 2-3 ladders sueltos.
function CompareLadder({ title, homeLines, awayLines, homeName, awayName }) {
  const allLines = [...new Set([...Object.keys(homeLines || {}), ...Object.keys(awayLines || {})])]
    .map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!allLines.length) return null;
  return (
    <div className="msa-compare">
      {title && <h3>{title}</h3>}
      <div className="msa-compare-head"><span /><span>{homeName}</span><span>{awayName}</span></div>
      {allLines.map((line) => (
        <div key={line} className="msa-compare-row">
          <span>Línea {line}</span>
          <b>{pct(homeLines?.[line]?.over)}</b>
          <b>{pct(awayLines?.[line]?.over)}</b>
        </div>
      ))}
    </div>
  );
}

function Expected({ value, homeName, awayName }) {
  if (!value || !Object.values(value).some((item) => item != null)) return null;
  return <div className="msa-expected"><span>{homeName}<b>{fmt(value.home)}</b></span><span>Total<b>{fmt(value.total)}</b></span><span>{awayName}<b>{fmt(value.away)}</b></span></div>;
}

// Columna por equipo (sin repetir el nombre en cada renglón).
function Spreads({ values, homeName, awayName }) {
  const homeEntries = Object.entries(values?.home || {}).sort((left, right) => Number(left[0]) - Number(right[0]));
  const awayEntries = Object.entries(values?.away || {}).sort((left, right) => Number(left[0]) - Number(right[0]));
  if (!homeEntries.length && !awayEntries.length) return null;
  const Column = ({ name, entries }) => (
    <div className="msa-spreads-col">
      <h4>{name}</h4>
      {entries.map(([line, value]) => (
        <div key={line} className="msa-spreads-row"><span>{Number(line) > 0 ? '+' : ''}{line}</span><b>{pct(value)}</b></div>
      ))}
    </div>
  );
  return <div className="msa-spreads-cols"><Column name={homeName} entries={homeEntries} /><Column name={awayName} entries={awayEntries} /></div>;
}

function FullFrequencies({ prediction, homeName, awayName, scoreLabel }) {
  if (!prediction) return <p className="msa-muted">Todavía no hay frecuencias calculadas.</p>;
  return (
    <>
      <div className="msa-block">
        <h3>Resultado y proyección general</h3>
        <Expected value={prediction.expected} homeName={homeName} awayName={awayName} />
        <div className="msa-pill-grid">
          <ProbabilityPill label={`${homeName} gana`} value={prediction.moneyline?.home} />
          <ProbabilityPill label="Empate" value={prediction.moneyline?.draw} />
          <ProbabilityPill label={`${awayName} gana`} value={prediction.moneyline?.away} />
        </div>
      </div>
      <div className="msa-block"><h3>Total del partido</h3><Mesh lines={prediction.totals?.lines} label={scoreLabel} /></div>
      <CompareLadder title={`Total — ${scoreLabel}`} homeLines={prediction.teamTotals?.home} awayLines={prediction.teamTotals?.away} homeName={homeName} awayName={awayName} />
      <div className="msa-block"><h3>Hándicaps calculados</h3><Spreads values={prediction.spreads} homeName={homeName} awayName={awayName} /></div>
      {Object.entries(prediction.periods || {}).map(([key, period]) => (
        <div className="msa-block" key={key}>
          <h3>{period.label || PERIOD_LABELS[key] || key}</h3>
          <Expected value={period.expected} homeName={homeName} awayName={awayName} />
          <div className="msa-pill-grid">
            <ProbabilityPill label={`${homeName} gana`} value={period.moneyline?.home} />
            <ProbabilityPill label="Empate" value={period.moneyline?.draw} />
            <ProbabilityPill label={`${awayName} gana`} value={period.moneyline?.away} />
          </div>
          <Mesh lines={period.totals} label={scoreLabel} />
          <CompareLadder homeLines={period.teamTotals?.home} awayLines={period.teamTotals?.away} homeName={homeName} awayName={awayName} />
          <Spreads values={period.spreads} homeName={homeName} awayName={awayName} />
        </div>
      ))}
      {Object.entries(prediction.statistics || {}).map(([key, values]) => (
        <div key={key}>
          <Expected value={values.expected} homeName={homeName} awayName={awayName} />
          <CompareLadder title={values.label || key} homeLines={values.home} awayLines={values.away} homeName={homeName} awayName={awayName} />
        </div>
      ))}
    </>
  );
}

export default function MultisportAnalysisPage(props) {
  const { isFree } = useFreeAccess();
  return isFree ? <main className="app free-detail"><Link href="/dashboard">← Volver al dashboard</Link><LockedAnalysis title="Análisis completo" /></main> : <PaidMultisportAnalysisPage {...props} />;
}

function PaidMultisportAnalysisPage({ sport, slug, sportLabel, scoreLabel }) {
  const params = useParams();
  const router = useRouter();
  const fixtureId = params.id;
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetch(`/api/sports/${sport}/match/${encodeURIComponent(fixtureId)}`)
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || 'No fue posible cargar el análisis');
        if (active) setPayload(json);
      })
      .catch((cause) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [fixtureId, sport]);

  const analysis = payload?.analysis;
  const match = payload?.match;
  const homeName = analysis?.home_team || match?.home_team || 'Local';
  const awayName = analysis?.away_team || match?.away_team || 'Visitante';
  const markets = useMemo(() => (analysis?.combinada?.selectable || []).filter(validMarket)
    .sort((left, right) => Number(right.rawProbability ?? right.probability) - Number(left.rawProbability ?? left.probability)
      || Number(right.odd) - Number(left.odd)), [analysis]);

  if (!payload && !error) return <DashboardBuffer />;
  if (error) return <div className="msa-page"><button className="msa-back" onClick={() => router.back()}>← Volver</button><div className="msa-error">{error}</div></div>;

  return (
    <main className="msa-page app">
      <Link className="msa-back" href={`/dashboard/${slug}`}>← Volver a {sportLabel}</Link>
      <header className="msa-hero">
        <small>{sportLabel} · {analysis.league_name}</small>
        <div><span><b>{homeName}</b><strong>{match?.home_score ?? '—'}</strong></span><em>VS</em><span><b>{awayName}</b><strong>{match?.away_score ?? '—'}</strong></span></div>
        <time>{analysis.start_time ? new Date(analysis.start_time).toLocaleString('es-ES') : ''}</time>
      </header>

      <SportAnalysisTabs game={{ id: fixtureId, analysis, teams: { home: { name: homeName }, away: { name: awayName } } }} sport={sport} scoreLabel={scoreLabel} />
      <Section title="Arma tu combinada · Bet365">
        <p className="msa-muted">Misma política de béisbol: línea exacta de Bet365, probabilidad mínima del 65% y cuota mínima de 1,20.</p>
        {markets.length ? <div className="msa-markets">{markets.map((market) => (
          <article key={market.id}><span><small>{market.marketLabel || market.market}</small><strong>{displayBettingText(market.name || market.pick)}</strong></span><span><b>{pct(market.rawProbability ?? market.probability)}</b><em>@{Number(market.odd).toFixed(2)}</em></span></article>
        ))}</div> : <div className="msa-empty">Bet365 no tiene ahora una línea exacta que cumpla ambos criterios. El análisis estadístico completo permanece visible.</div>}
      </Section>

      <Section title="Frecuencias calculadas · análisis completo">
        <p className="msa-muted">Incluye todos los periodos y líneas calculadas, aunque la casa no ofrezca cuota. Estas cifras no se convierten por sí solas en recomendaciones.</p>
        <FullFrequencies prediction={analysis.probabilities} homeName={homeName} awayName={awayName} scoreLabel={scoreLabel} />
      </Section>

      <FinalVerdictPanel verdict={analysis.analysis?.finalVerdict} homeName={homeName} awayName={awayName} />
    </main>
  );
}
