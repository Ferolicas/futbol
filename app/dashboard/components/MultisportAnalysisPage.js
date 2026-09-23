'use client';
import { useFreeAccess, LockedAnalysis } from './FreeAccessProvider';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChartColumn, Clock, Layers3, Scale, Sigma, Trophy } from 'lucide-react';
import DashboardBuffer from './DashboardBuffer';
import FinalVerdictPanel from './FinalVerdictPanel';
import { displayBettingText } from '../utils/display-betting-text';
import { settleMarketSelection } from '../../../lib/market-settlement';
import {
  AccordionSection, CompareTable, DocPage, ExpectedRow, MarketCard, MoneylineTiles, OverUnderTable, Panel,
  SpreadColumns, SportHero, SubAccordion,
} from './FullAnalysisKit';

const PERIOD_LABELS = Object.freeze({
  firstHalf: 'Primera mitad', secondHalf: 'Segunda mitad', quarter1: 'Primer cuarto', quarter2: 'Segundo cuarto',
  quarter3: 'Tercer cuarto', quarter4: 'Cuarto cuarto', first3: 'Primeras 3 entradas', first4_5: 'Primeras 4,5 entradas',
  first5: 'Primeras 5 entradas', first7: 'Primeras 7 entradas',
});

const normalizedBookmaker = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');
const validMarket = (market) => normalizedBookmaker(market?.bookmaker) === 'bet365'
  && Number(market?.odd) >= 1.2 && Number(market?.rawProbability ?? market?.probability) >= 65;

/** Frecuencias completas: mismo documento que MultisportFullFrequencies de la app. */
function FullFrequencies({ prediction, homeName, awayName, scoreLabel }) {
  if (!prediction) return <p className="fak-empty">Todavía no hay frecuencias calculadas.</p>;
  const periods = Object.entries(prediction.periods || {});
  const statistics = Object.entries(prediction.statistics || {});
  return (
    <>
      <AccordionSection title="Resultado y proyección general" icon={Trophy}>
        <ExpectedRow value={prediction.expected} homeName={homeName} awayName={awayName} />
        <MoneylineTiles moneyline={prediction.moneyline} homeName={homeName} awayName={awayName} />
      </AccordionSection>
      <AccordionSection title={`Total del partido · ${scoreLabel}`} icon={Sigma} accent="#22d3ee">
        <OverUnderTable lines={prediction.totals?.lines} />
        <Panel title={`Total por equipo · ${scoreLabel}`}><CompareTable homeLines={prediction.teamTotals?.home} awayLines={prediction.teamTotals?.away} homeName={homeName} awayName={awayName} /></Panel>
      </AccordionSection>
      {prediction.spreads && (
        <AccordionSection title="Hándicaps calculados" icon={Scale} accent="#fbbf24">
          <SpreadColumns values={prediction.spreads} homeName={homeName} awayName={awayName} />
        </AccordionSection>
      )}
      {periods.length > 0 && (
        <AccordionSection title="Análisis por periodo" icon={Clock} accent="#818cf8" count={periods.length}>
          {periods.map(([key, period], index) => (
            <SubAccordion key={key} title={period.label || PERIOD_LABELS[key] || key} defaultOpen={index === 0}>
              <ExpectedRow value={period.expected} homeName={homeName} awayName={awayName} />
              <MoneylineTiles moneyline={period.moneyline} homeName={homeName} awayName={awayName} />
              <OverUnderTable lines={period.totals} />
              <CompareTable homeLines={period.teamTotals?.home} awayLines={period.teamTotals?.away} homeName={homeName} awayName={awayName} />
              <SpreadColumns values={period.spreads} homeName={homeName} awayName={awayName} />
            </SubAccordion>
          ))}
        </AccordionSection>
      )}
      {statistics.length > 0 && (
        <AccordionSection title="Estadísticas de equipos" icon={ChartColumn} accent="#f97316" count={statistics.length}>
          {statistics.map(([key, values], index) => (
            <SubAccordion key={key} title={values.label || key} defaultOpen={index < 2}>
              <ExpectedRow value={values.expected} homeName={homeName} awayName={awayName} />
              <CompareTable homeLines={values.home} awayLines={values.away} homeName={homeName} awayName={awayName} />
            </SubAccordion>
          ))}
        </AccordionSection>
      )}
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
  const back = () => router.push(`/dashboard/${slug}`);
  const title = `${sportLabel} · análisis completo`;

  if (!payload && !error) return <DashboardBuffer />;
  if (error) return <DocPage onBack={back} title={title}><div className="fak-error">{error}</div></DocPage>;

  const prediction = analysis?.probabilities?.evidence || analysis?.probabilities;
  const game = { id: fixtureId, teams: { home: { name: homeName }, away: { name: awayName } }, status: { short: match?.status }, liveResult: match, analysis };
  return (
    <DocPage onBack={back} title={title}>
      <SportHero kicker={`${sportLabel} · ${analysis?.league_name || ''}`} homeName={homeName} awayName={awayName} homeLogo={match?.home_logo ?? null} awayLogo={match?.away_logo ?? null}
        homeScore={match?.home_score} awayScore={match?.away_score} homeProb={prediction?.moneyline?.home} awayProb={prediction?.moneyline?.away} startTime={analysis?.start_time} />
      <AccordionSection title="Arma tu combinada · Bet365" icon={Layers3} count={markets.length} hint="Línea exacta de Bet365, probabilidad mínima del 65% y cuota mínima de 1,20.">
        {markets.length ? markets.map((market) => (
          <MarketCard key={market.id} name={market.name || market.pick} probability={Number(market.rawProbability ?? market.probability)} odd={market.odd} bookmaker={market.bookmaker} reliability={market.reliability}
            validation={displayBettingText(market.marketLabel || market.market || '')} outcome={settleMarketSelection({ sport, selection: market, game, liveResult: match })} />
        )) : <p className="fak-empty">Bet365 no tiene ahora una línea exacta que cumpla ambos criterios. El análisis estadístico completo permanece visible.</p>}
      </AccordionSection>
      <FullFrequencies prediction={prediction} homeName={homeName} awayName={awayName} scoreLabel={scoreLabel} />
      <FinalVerdictPanel verdict={analysis?.analysis?.finalVerdict} homeName={homeName} awayName={awayName} />
    </DocPage>
  );
}
