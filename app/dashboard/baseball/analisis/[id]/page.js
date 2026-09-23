'use client';
import { useFreeAccess, LockedAnalysis } from '../../../components/FreeAccessProvider';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Activity, ChartColumn, Clock, History, Layers3, ListOrdered, RefreshCw, Sigma, Sparkles, Target, Users } from 'lucide-react';
import DashboardBuffer from '../../../components/DashboardBuffer';
import BaseballResultStats from '../../components/BaseballResultStats';
import { displayBettingText } from '../../../utils/display-betting-text';
import { BASEBALL_RECOMMENDATION_MIN_PROBABILITY } from '../../../../../lib/recommendation-policy';
import { marketResultState, settleMarketSelection } from '../../../../../lib/market-settlement';
import FinalVerdictPanel from '../../../components/FinalVerdictPanel';
import {
  AccordionSection, CompareTable, DocPage, Grid, H2HTable, KeyValue, MarketCard, MoneylineTiles, OverUnderTable,
  Panel, ProbTile, SpreadColumns, SportHero, StatTile, SubAccordion, capPct, numText, pctText, prob,
} from '../../../components/FullAnalysisKit';

const isBet365Market = (market) => String(market?.bookmaker || '').normalize('NFD')
  .replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '') === 'bet365'
  && Number(market?.odd) >= 1.20
  && Number(market?.rawProbability ?? market?.probability) >= BASEBALL_RECOMMENDATION_MIN_PROBABILITY;

const PERIOD_LABELS = Object.freeze({
  first3: 'Primeras 3 entradas', first4_5: 'Primeras 4,5 entradas', first5: 'Primeras 5 entradas', first7: 'Primeras 7 entradas',
});
const PLAYER_CATEGORY_LABELS = Object.freeze({
  hits: 'Hits', homeRuns: 'Jonrones', totalBases: 'Bases totales', rbis: 'Carreras impulsadas', runs: 'Carreras anotadas',
  walks: 'Bases por bolas', stolenBases: 'Bases robadas', strikeouts: 'Ponches del lanzador', battingStrikeouts: 'Ponches del bateador',
});

export function BaseballAnalysisExperience(props) {
  const { isFree } = useFreeAccess();
  return isFree ? <div className="app free-detail"><LockedAnalysis title="Análisis completo" /></div> : <PaidBaseballAnalysisExperience {...props} />;
}

function PaidBaseballAnalysisExperience({ fixtureId, embedded = false, onClose }) {
  const params = useParams();
  const router = useRouter();
  const fid = fixtureId || params.id;
  const closeOrBack = () => {
    if (embedded && onClose) onClose();
    else router.back();
  };

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [analyzing, setAnalyzing] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/baseball/match/${fid}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed');
      setData(json);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (fid) fetchData(); }, [fid]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      const res = await fetch(`/api/baseball/match/${fid}/analyze`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Analysis failed');
      await fetchData();
    } catch (e) {
      setError(e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  if (loading && !data) return <DashboardBuffer compact={embedded} />;

  if (error && !data) {
    return (
      <DocPage onBack={closeOrBack} title="Béisbol · análisis completo" embedded={embedded}>
        <div className="fak-error">{error}</div>
        <button type="button" className="fak-btn" onClick={handleAnalyze} disabled={analyzing}>{analyzing ? 'Analizando...' : 'Generar análisis ahora'}</button>
      </DocPage>
    );
  }

  const a = data?.analysis;
  const result = data?.result;
  const probs = a?.probabilities;
  const combinada = a?.combinada;
  const dq = a?.data_quality;
  const markets = (Array.isArray(combinada?.selectable) ? combinada.selectable : [])
    .filter(isBet365Market)
    .sort((left, right) => Number(right.rawProbability ?? right.probability) - Number(left.rawProbability ?? left.probability)
      || Number(right.odd) - Number(left.odd));
  const highlighted = (Array.isArray(combinada?.selections) ? combinada.selections : []).filter(isBet365Market);
  const homeName = a?.home_team || 'Local';
  const awayName = a?.away_team || 'Visitante';
  const game = { id: Number(fid), teams: { home: { name: homeName }, away: { name: awayName } }, status: { short: result?.status || a?.status }, liveResult: result, analysis: a };
  const state = marketResultState({ sport: 'baseball', game, liveResult: result });
  const badges = dq ? [
    [`Calidad: ${dq.score}%`, dq.score >= 75 ? '#10b981' : dq.score >= 50 ? '#f59e0b' : '#ef4444'],
    ...(dq.hasOdds ? [['Cuotas Bet365', '#22d3ee']] : []),
    ...(dq.hasH2H ? [['H2H', '#8b5cf6']] : []),
    ...(dq.hasHomeStats && dq.hasAwayStats ? [['Stats', '#10b981']] : []),
    ...(dq.hasPitcherMatchup ? [['Pitcher', '#f59e0b']] : []),
    ...(dq.hasPlayerHighlights ? [['Players', '#a78bfa']] : []),
  ] : [];
  const periods = Object.entries(probs?.periods || {}).filter(([key]) => !/^inning\d+$/.test(key));
  const innings = Object.entries(probs?.innings || {}).sort((l, r) => Number(l[0]) - Number(r[0]));
  const statistics = Object.entries(probs?.statistics || {});
  const pitchers = probs?.pitchers || a?.analysis?.pitcherMatchup;
  const hasPitchers = !!(pitchers?.home || pitchers?.away);
  const expected = probs?.expected;

  return (
    <DocPage onBack={closeOrBack} title="Béisbol · análisis completo" embedded={embedded}>
      <SportHero kicker={`Béisbol · ${a?.country || ''} · ${a?.league_name || ''}`} homeName={homeName} awayName={awayName} homeScore={result?.home_score} awayScore={result?.away_score} homeProb={probs?.moneyline?.home} awayProb={probs?.moneyline?.away} startTime={a?.start_time} badges={badges} />

      {result?.home_score != null && result?.away_score != null && (
        <AccordionSection title={result.status === 'FT' ? 'Resultado oficial MLB' : 'Estadísticas en vivo MLB'} icon={Activity} accent="#22d3ee">
          <BaseballResultStats result={result} homeName={homeName} awayName={awayName} />
        </AccordionSection>
      )}

      {highlighted.length > 0 && Number(combinada?.combinedProbability) >= 60 && (
        <AccordionSection title="Combinada Bet365 del partido" icon={Layers3} count={highlighted.length}>
          {highlighted.map((s, i) => (
            <div key={i} className="fak-combo-row">
              <span><small>{s.marketLabel || s.market}</small><strong>{displayBettingText(s.pick || s.name)}</strong></span>
              <b style={{ color: '#5ee6b1' }}>{capPct(s.rawProbability ?? s.probability)}%</b>
              <b style={{ color: '#f5e400' }}>@{Number(s.odd).toFixed(2)}</b>
            </div>
          ))}
          <Grid columns={2}>
            <StatTile label="Probabilidad combinada" value={`${capPct(combinada.combinedProbability)}%`} />
            <StatTile label="Cuota combinada" value={combinada.combinedOdd ? `@${combinada.combinedOdd}` : '—'} color="#22d3ee" />
          </Grid>
        </AccordionSection>
      )}

      <AccordionSection title="Opciones disponibles en Bet365" icon={Layers3} count={markets.length} hint={`Línea exacta de Bet365, probabilidad mínima del ${BASEBALL_RECOMMENDATION_MIN_PROBABILITY}% y cuota mínima de 1,20.`}>
        {markets.length ? markets.map((m) => (
          <MarketCard key={m.id} name={m.name || m.pick} probability={Number(m.rawProbability ?? m.probability)} odd={m.odd} bookmaker={m.bookmaker} reliability={m.reliability} validation={m.marketLabel || m.market}
            outcome={settleMarketSelection({ sport: 'baseball', selection: m, game, liveResult: result })} pendingLabel={state.isLive ? 'En juego' : state.isFinal ? 'Pendiente oficial' : null} />
        )) : <p className="fak-empty">Bet365 no tiene ahora una línea exacta que cumpla ambos criterios. El análisis estadístico completo permanece visible.</p>}
      </AccordionSection>

      {hasPitchers && (
        <AccordionSection title="Lanzadores abridores" icon={Target} accent="#fbbf24">
          <Grid columns={2}>
            {['home', 'away'].map((side) => {
              const pitcher = pitchers?.[side];
              return (
                <Panel key={side} title={side === 'home' ? homeName : awayName}>
                  <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '.84rem' }}>{pitcher?.name || 'Por confirmar'}</strong>
                  <KeyValue label="ERA" value={numText(pitcher?.stats?.era)} />
                  <KeyValue label="WHIP" value={numText(pitcher?.stats?.whip)} />
                  <KeyValue label="K/9" value={numText(pitcher?.stats?.k9)} />
                  <KeyValue label="IP" value={numText(pitcher?.stats?.ip, 1)} />
                  <KeyValue label="Prob. de ganar" value={pctText(probs?.moneyline?.[side] ?? combinada?.winProbabilities?.[side])} />
                </Panel>
              );
            })}
          </Grid>
        </AccordionSection>
      )}

      <BaseballPlayers players={probs?.players} />

      {probs && (
        <AccordionSection title="Análisis estadístico completo" icon={Sigma} hint="Todo lo calculado con los antecedentes reales; las cuotas solo determinan qué opciones pasan a la sección apostable.">
          {expected && (
            <Grid columns={3}>
              <StatTile label={homeName} value={numText(expected.lambdaHome)} sub="carreras" />
              <StatTile label="Total" value={numText(expected.totalRuns)} color="#22d3ee" sub="carreras" />
              <StatTile label={awayName} value={numText(expected.lambdaAway)} sub="carreras" />
            </Grid>
          )}
          <MoneylineTiles moneyline={probs.moneyline} homeName={homeName} awayName={awayName} />
          <Panel title="Total de carreras"><OverUnderTable lines={probs.totals?.lines} /></Panel>
          <Panel title="Carreras por equipo"><CompareTable homeLines={probs.teamTotals?.home} awayLines={probs.teamTotals?.away} homeName={homeName} awayName={awayName} /></Panel>
          {probs.runLines && <Panel title="Hándicaps de carreras"><SpreadColumns values={probs.runLines} homeName={homeName} awayName={awayName} /></Panel>}
        </AccordionSection>
      )}

      {periods.length > 0 && (
        <AccordionSection title="Tramos acumulados del partido" icon={Clock} accent="#818cf8" count={periods.length}>
          {periods.map(([key, period], index) => (
            <SubAccordion key={key} title={period.label || PERIOD_LABELS[key] || key} defaultOpen={index === 0}>
              <MoneylineTiles moneyline={period.moneyline} homeName={homeName} awayName={awayName} />
              <OverUnderTable lines={period.totals} />
            </SubAccordion>
          ))}
        </AccordionSection>
      )}

      {innings.length > 0 && (
        <AccordionSection title="Análisis entrada por entrada" icon={ListOrdered} accent="#2dd4bf" count={innings.length} hint="Las nueve entradas se calculan con el historial real disponible, aunque Bet365 no tenga cuota para esa entrada.">
          {innings.map(([inning, values], index) => (
            <SubAccordion key={inning} title={`${inning}.ª entrada`} meta={`media ${numText(values.expected?.total)}`} defaultOpen={index === 0}>
              <Grid columns={2}>
                <ProbTile label="Habrá carrera" value={values.run?.yes} />
                <ProbTile label="Sin carrera" value={values.run?.no} color="#fbbf24" />
                <ProbTile label={`${homeName} anota`} value={values.teamTotals?.home?.['0.5']?.over} />
                <ProbTile label={`${awayName} anota`} value={values.teamTotals?.away?.['0.5']?.over} />
              </Grid>
              <OverUnderTable lines={values.totals} />
            </SubAccordion>
          ))}
        </AccordionSection>
      )}

      {statistics.length > 0 && (
        <AccordionSection title="Estadísticas de equipos" icon={ChartColumn} accent="#f97316" count={statistics.length}>
          {statistics.map(([key, values], index) => (
            <SubAccordion key={key} title={values.label || key} defaultOpen={index < 2}>
              <CompareTable homeLines={values.home} awayLines={values.away} homeName={homeName} awayName={awayName} />
            </SubAccordion>
          ))}
        </AccordionSection>
      )}

      <BaseballSpecials specials={probs?.specials} homeName={homeName} awayName={awayName} />

      {a?.analysis?.h2h?.length > 0 && (
        <AccordionSection title="Últimos enfrentamientos (H2H)" icon={History} accent="#a855f7" count={Math.min(6, a.analysis.h2h.length)}>
          <H2HTable rows={a.analysis.h2h.slice(0, 6).map((h) => ({ date: h.date, home: h.teams?.home?.name, away: h.teams?.away?.name, hs: h.scores?.home?.total ?? h.scores?.home, as: h.scores?.away?.total ?? h.scores?.away }))} />
        </AccordionSection>
      )}

      <FinalVerdictPanel verdict={a?.analysis?.finalVerdict} homeName={homeName} awayName={awayName} />

      {/* Re-analizar manual va por /ferney (admin); aquí solo se relee la BD
          por si el cron actualizó en segundo plano. */}
      <button type="button" className="fak-btn" onClick={fetchData} disabled={loading}><RefreshCw size={15} aria-hidden="true" /> Refrescar</button>
    </DocPage>
  );
}

export default function BaseballAnalysisPage() {
  return <BaseballAnalysisExperience />;
}

/** Bateadores y lanzadores: un acordeón por categoría (las 2 primeras abiertas). */
function BaseballPlayers({ players }) {
  const rows = Object.entries(players || {}).filter(([, entries]) => Array.isArray(entries) && entries.length);
  if (!rows.length) return null;
  return (
    <AccordionSection title="Bateadores y lanzadores" icon={Users} accent="#a78bfa" count={rows.length} hint="Cada porcentaje sale del registro partido a partido del jugador. Este bloque no depende de que exista una cuota.">
      {rows.map(([category, entries], index) => (
        <SubAccordion key={category} title={PLAYER_CATEGORY_LABELS[category] || category} meta={`${entries.length} jugadores`} defaultOpen={index < 2}>
          {entries.map((player) => (
            <Panel key={`${category}-${player.id || player.name}`}>
              <div className="fak-player">
                {player.photo && <img src={player.photo} alt="" loading="lazy" />}
                <span style={{ minWidth: 0 }}>
                  <strong>{player.name}</strong>
                  <small>{player.teamName || 'MLB'} · media {numText(player.mean)} · {player.history?.length || 0} partidos</small>
                </span>
              </div>
              <OverUnderTable lines={Object.fromEntries(Object.entries(player.lineSides || {}).map(([line, sides]) => [line, { over: sides.over?.probability, under: sides.under?.probability }]))} />
              {player.history?.length > 0 && <p className="fak-faint" style={{ margin: 0 }}>Últimos registros: {player.history.slice(-10).reverse().join(' · ')}</p>}
            </Panel>
          ))}
        </SubAccordion>
      ))}
    </AccordionSection>
  );
}

/** Situaciones especiales: malla de 2 columnas + acordeón con marcadores. */
function BaseballSpecials({ specials, homeName, awayName }) {
  if (!specials || !Object.keys(specials).length) return null;
  const pairs = [
    ['Total impar', specials.totalParity?.odd, 'Total par', specials.totalParity?.even],
    [`${homeName} anota primero`, specials.firstTeamScore?.home, `${awayName} anota primero`, specials.firstTeamScore?.away],
    [`${homeName} anota último`, specials.lastTeamScore?.home, `${awayName} anota último`, specials.lastTeamScore?.away],
    ['Habrá entradas extra', specials.extraInnings?.yes, 'Sin entradas extra', specials.extraInnings?.no],
    [`${homeName}: impares`, specials.teamParity?.home?.odd, `${homeName}: pares`, specials.teamParity?.home?.even],
    [`${awayName}: impares`, specials.teamParity?.away?.odd, `${awayName}: pares`, specials.teamParity?.away?.even],
    [`${homeName} con más carreras`, specials.highestScoring?.home, `${awayName} con más carreras`, specials.highestScoring?.away],
  ].filter(([, l, , r]) => prob(l) != null || prob(r) != null);
  const detailed = [
    ...Object.entries(specials.correctScore || {}).map(([key, value]) => [`Marcador exacto ${key}`, value]),
    ...Object.entries(specials.halfFull || {}).map(([key, value]) => [`Primeras 5 / final: ${displayBettingText(key)}`, value]),
    ...Object.entries(specials.resultTotals || {}).map(([key, value]) => [`Resultado y carreras: ${displayBettingText(key)}`, value]),
  ].filter(([, value]) => prob(value) != null);
  if (!pairs.length && !detailed.length) return null;
  return (
    <AccordionSection title="Situaciones especiales" icon={Sparkles} accent="#f472b6">
      {pairs.map(([l, lv, r, rv]) => (
        <Grid key={l} columns={2}>
          <StatTile label={l} value={pctText(lv)} />
          <StatTile label={r} value={pctText(rv)} color="#fbbf24" />
        </Grid>
      ))}
      {detailed.length > 0 && (
        <SubAccordion title="Marcadores y combinaciones calculadas" meta={String(detailed.length)}>
          {detailed.map(([label, value]) => <KeyValue key={label} label={label} value={pctText(value)} />)}
        </SubAccordion>
      )}
    </AccordionSection>
  );
}
