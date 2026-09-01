'use client';

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

function Ladder({ title, lines, label = 'puntos' }) {
  const entries = Object.entries(lines || {}).sort((left, right) => Number(left[0]) - Number(right[0]));
  if (!entries.length) return null;
  return (
    <div className="msa-ladder">
      {title && <h3>{title}</h3>}
      {entries.map(([line, values]) => (
        <div key={line}><strong>{line} {label}</strong><ProbabilityPill label="Más" value={values?.over} /><ProbabilityPill label="Menos" value={values?.under} /></div>
      ))}
    </div>
  );
}

function Expected({ value, homeName, awayName }) {
  if (!value || !Object.values(value).some((item) => item != null)) return null;
  return <div className="msa-expected"><span>{homeName}<b>{fmt(value.home)}</b></span><span>Total<b>{fmt(value.total)}</b></span><span>{awayName}<b>{fmt(value.away)}</b></span></div>;
}

function Spreads({ values, homeName, awayName }) {
  const rows = [
    ...Object.entries(values?.home || {}).map(([line, value]) => ({ side: homeName, line, value })),
    ...Object.entries(values?.away || {}).map(([line, value]) => ({ side: awayName, line, value })),
  ];
  if (!rows.length) return null;
  return <div className="msa-pill-grid">{rows.map((row) => <ProbabilityPill key={`${row.side}-${row.line}`} label={`${row.side} ${Number(row.line) > 0 ? '+' : ''}${row.line}`} value={row.value} />)}</div>;
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
      <div className="msa-grid">
        <Ladder title={`Total del partido`} lines={prediction.totals?.lines} label={scoreLabel} />
        <Ladder title={homeName} lines={prediction.teamTotals?.home} label={scoreLabel} />
        <Ladder title={awayName} lines={prediction.teamTotals?.away} label={scoreLabel} />
      </div>
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
          <div className="msa-grid">
            <Ladder title="Total" lines={period.totals} label={scoreLabel} />
            <Ladder title={homeName} lines={period.teamTotals?.home} label={scoreLabel} />
            <Ladder title={awayName} lines={period.teamTotals?.away} label={scoreLabel} />
          </div>
          <Spreads values={period.spreads} homeName={homeName} awayName={awayName} />
        </div>
      ))}
      {Object.entries(prediction.statistics || {}).map(([key, values]) => (
        <div className="msa-block" key={key}>
          <h3>{values.label || key}</h3>
          <Expected value={values.expected} homeName={homeName} awayName={awayName} />
          <div className="msa-grid">
            <Ladder title={homeName} lines={values.home} label={values.label || key} />
            <Ladder title={awayName} lines={values.away} label={values.label || key} />
            <Ladder title="Total" lines={values.total} label={values.label || key} />
          </div>
        </div>
      ))}
    </>
  );
}

export default function MultisportAnalysisPage({ sport, slug, sportLabel, scoreLabel }) {
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
    <main className="msa-page">
      <Link className="msa-back" href={`/dashboard/${slug}`}>← Volver a {sportLabel}</Link>
      <header className="msa-hero">
        <small>{sportLabel} · {analysis.league_name}</small>
        <div><span><b>{homeName}</b><strong>{match?.home_score ?? '—'}</strong></span><em>VS</em><span><b>{awayName}</b><strong>{match?.away_score ?? '—'}</strong></span></div>
        <time>{analysis.start_time ? new Date(analysis.start_time).toLocaleString('es-ES') : ''}</time>
      </header>

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
