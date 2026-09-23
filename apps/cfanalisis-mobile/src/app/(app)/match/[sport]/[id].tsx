import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Activity, AlertTriangle, ChartColumn, ChevronLeft, Clock, History, Layers, ListOrdered, Percent, RefreshCw, Scale, Sigma, Sparkles, Star, Target, TrendingUp, Trophy, Users, Zap } from 'lucide-react-native';
import { AppText, Banner, Button, Card, Screen, SkeletonList, TeamLogo } from '@/components/ui';
import { MatchHeadCard } from '@/components/dashboard/MatchHeadCard';
import { AccordionSection, CompareTable, ExpectedRow, Grid, KeyValue, OverUnderTable, Panel, ProbTile, SpreadColumns, StatTile, SubAccordion, numText, pctText, prob } from '@/components/analysis/FullAnalysisKit';
import { FinalVerdictPanel } from '@/components/analysis/FinalVerdictPanel';
import { LockedAnalysis } from '@/components/analysis/FreeAccess';
import { MarketButton } from '@/components/analysis/MarketButton';
import { PlayersBlock, ProbBlock, footballMarkets, hasPlayerHighlights } from '@/components/analysis/FootballAnalysisTabs';
import { BaseballResultStats } from '@/components/analysis/SportAnalysisTabs';
import { api, ApiError } from '@/lib/api';
import { useAccess } from '@/lib/access-context';
import { useSelectedMarkets } from '@/lib/selected-markets';
import { setFixtureLiveStats, useFixtureLiveStats } from '@/lib/realtime/fixture-store';
import { marketResultState, settleMarketSelection } from '@/shared/market-settlement';
import { displayBettingText } from '@/shared/display-betting-text';
import { cap } from '@/lib/format';
import { fmtDateTime, getUserTz, todayInTz } from '@/lib/timezone';
import { colors, radius } from '@/theme/tokens';

const SPORT_LABEL: Record<string, string> = { football: 'Fútbol', baseball: 'Béisbol', basketball: 'Baloncesto', american_football: 'Fútbol americano' };
const normalizedBookmaker = (value: unknown) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const bet365Market = (market: any) => normalizedBookmaker(market?.bookmaker) === 'bet365' && Number(market?.odd) >= 1.2 && Number(market?.rawProbability ?? market?.probability) >= 65;

function Header({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <View style={styles.topbar}>
      <Pressable onPress={onBack} style={styles.back} accessibilityLabel="Volver"><ChevronLeft size={18} color={colors.text} /><AppText variant="label">Volver</AppText></Pressable>
      <AppText variant="kicker" tone="muted">{title}</AppText>
    </View>
  );
}

/** Mismas bajas del once titular que la web (BajasSection): refresca vía
 * la misma acción del endpoint /api/match/[id]. */
function InjuriesSection({ id, filteredInjuries, allInjuries, onRefreshed }: { id: string; filteredInjuries: any[]; allInjuries: any[]; onRefreshed: (injuries: any) => void }) {
  const [refreshing, setRefreshing] = useState(false);
  const hasData = Array.isArray(allInjuries) && allInjuries.length > 0;
  const filtered = filteredInjuries || [];

  const refresh = async () => {
    setRefreshing(true);
    try {
      const data = await api.post<any>(`/api/match/${id}`, { action: 'refresh-injuries' });
      if (data.injuries) onRefreshed(data.injuries);
    } catch {} finally { setRefreshing(false); }
  };

  if (!hasData) {
    return (
      <Card style={{ alignItems: 'center', gap: 10 }}>
        <AppText tone="muted">Sin bajas confirmadas aún</AppText>
        <Button title={refreshing ? 'Actualizando…' : 'Actualizar bajas'} loading={refreshing} variant="secondary" onPress={refresh} />
      </Card>
    );
  }
  if (filtered.length === 0) {
    return (
      <Card style={{ alignItems: 'center', gap: 10 }}>
        <Banner tone="success" message="Once titular sin bajas confirmadas" />
        <Button title={refreshing ? 'Actualizando…' : 'Actualizar bajas'} loading={refreshing} variant="secondary" onPress={refresh} />
      </Card>
    );
  }
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <AlertTriangle size={16} color={colors.error} />
        <AppText tone="error" weight="bold">{filtered.length} baja{filtered.length > 1 ? 's' : ''} en el once titular</AppText>
      </View>
      {filtered.map((inj: any, i: number) => (
        <Card key={i} tone="error" style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TeamLogo src={inj.team?.logo} name={inj.team?.name} size={18} />
            <AppText variant="caption" tone="muted">{inj.team?.name}</AppText>
          </View>
          <AppText variant="label" weight="bold">{inj.player?.name}</AppText>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            <AppText variant="caption" tone="error">{inj.player?.type}</AppText>
            <AppText variant="caption" tone="warning">{inj.player?.reason || 'N/A'}</AppText>
          </View>
        </Card>
      ))}
      <Button title={refreshing ? 'Actualizando…' : 'Actualizar bajas'} loading={refreshing} variant="secondary" onPress={refresh} />
    </View>
  );
}

/** XI titular + suplentes, con botón de actualizar si aún no está disponible
 * (mismo action=refresh-lineups del endpoint que usa la web). */
function LineupsSection({ id, lineups, onRefreshed }: { id: string; lineups: any; onRefreshed: (lineups: any) => void }) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    setRefreshing(true); setError('');
    try {
      const data = await api.post<any>(`/api/match/${id}`, { action: 'refresh-lineups' });
      if (data.lineups) onRefreshed(data.lineups);
      if (data.lineups && !data.lineups.available) setError('Alineaciones aún no publicadas');
    } catch (cause: any) { setError(cause?.message || 'Error al actualizar alineaciones'); }
    finally { setRefreshing(false); }
  };

  if (!lineups?.available) {
    return (
      <Card tone="warning" style={{ alignItems: 'center', gap: 10 }}>
        <AlertTriangle size={28} color={colors.warning} />
        <AppText weight="bold">Alineaciones no disponibles aún</AppText>
        <Button title={refreshing ? 'Actualizando…' : 'Actualizar alineaciones'} loading={refreshing} onPress={refresh} />
        {error ? <AppText variant="caption" tone="error">{error}</AppText> : null}
      </Card>
    );
  }
  return (
    <View style={{ gap: 10 }}>
      {lineups.data.map((team: any, index: number) => (
        <Card key={index} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TeamLogo src={team.team?.logo} name={team.team?.name} size={24} />
            <AppText variant="label" weight="bold" style={{ flex: 1 }}>{team.team?.name}</AppText>
            <AppText variant="mono" size={12} tone="accent">{team.formation}</AppText>
          </View>
          <AppText variant="caption" tone="muted">DT: {team.coach?.name || 'N/A'}</AppText>
          <AppText variant="caption" tone="secondary" weight="bold">Titulares</AppText>
          {(team.startXI || []).map((pl: any, i: number) => (
            <View key={i} style={styles.playerRow}>
              <AppText variant="mono" size={11} tone="muted" style={{ width: 26 }}>{pl.player?.number}</AppText>
              <AppText variant="caption" style={{ flex: 1 }} numberOfLines={1}>{pl.player?.name}</AppText>
              <AppText variant="caption" tone="faint">{pl.player?.pos}</AppText>
            </View>
          ))}
          {(team.substitutes || []).length > 0 && (
            <>
              <AppText variant="caption" tone="secondary" weight="bold" style={{ marginTop: 6 }}>Suplentes</AppText>
              {team.substitutes.map((pl: any, i: number) => (
                <View key={i} style={[styles.playerRow, { opacity: 0.7 }]}>
                  <AppText variant="mono" size={11} tone="faint" style={{ width: 26 }}>{pl.player?.number}</AppText>
                  <AppText variant="caption" tone="faint" style={{ flex: 1 }} numberOfLines={1}>{pl.player?.name}</AppText>
                  <AppText variant="caption" tone="faint">{pl.player?.pos}</AppText>
                </View>
              ))}
            </>
          )}
        </Card>
      ))}
      <Button title={refreshing ? 'Actualizando…' : 'Actualizar alineaciones'} loading={refreshing} variant="secondary" onPress={refresh} />
    </View>
  );
}

// Heatmap rojo→verde: mismo criterio que la web (hue 0=rojo a 120=verde
// interpolado por porcentaje real, no 3 cubetas discretas).
function heatmapColor(prob: number): { background: string; color: string } {
  const pct = Math.max(0, Math.min(100, Number(prob) || 0));
  const hue = (pct / 100) * 120;
  return { background: `hsl(${hue}, 70%, 32%)`, color: pct >= 40 && pct <= 65 ? '#1a1a1a' : '#fff' };
}

/** Probabilidad de gol por periodo de 15': una tabla de 6 columnas iguales
 * (cabecera de minutos + una fila por Combinado/local/visitante). */
function GoalTimingSection({ goalTiming, homeTeam, awayTeam }: { goalTiming: any; homeTeam: string; awayTeam: string }) {
  const periods = ['0-15', '15-30', '30-45', '45-60', '60-75', '75-90'];
  const at = (data: any[], i: number) => cap(data?.[i]?.probability || 0);
  return (
    <View style={styles.heatTable}>
      <View style={styles.heatRow}>
        {periods.map((p) => <AppText key={p} variant="caption" tone="faint" align="center" style={{ flex: 1 }}>{p}&apos;</AppText>)}
      </View>
      {[['Combinado', goalTiming.combined], [homeTeam, goalTiming.home], [awayTeam, goalTiming.away]].map(([label, data]: any) => (
        <View key={label} style={{ gap: 5 }}>
          <AppText variant="kicker" tone="muted" numberOfLines={1}>{label}</AppText>
          <View style={styles.heatRow}>
            {periods.map((p, i) => {
              const value = at(data, i);
              const heat = heatmapColor(value);
              return (
                <View key={p} style={[styles.heatCell, { backgroundColor: heat.background }]}>
                  <AppText variant="mono" size={11} weight="bold" style={{ color: heat.color }} numberOfLines={1} adjustsFontSizeToFit>{Math.round(value)}%</AppText>
                </View>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

const PERIOD_LABELS: Record<string, string> = {
  firstHalf: 'Primera mitad', secondHalf: 'Segunda mitad', quarter1: 'Primer cuarto', quarter2: 'Segundo cuarto',
  quarter3: 'Tercer cuarto', quarter4: 'Cuarto cuarto', first3: 'Primeras 3 entradas', first4_5: 'Primeras 4,5 entradas',
  first5: 'Primeras 5 entradas', first7: 'Primeras 7 entradas',
};

/** Ganador en tiles iguales (2 o 3 según haya empate). */
function MoneylineTiles({ moneyline, homeName, awayName }: { moneyline: any; homeName: string; awayName: string }) {
  const draw = moneyline?.draw ?? moneyline?.tie;
  const tiles = [[homeName, moneyline?.home], ...(prob(draw) != null ? [['Empate', draw]] : []), [awayName, moneyline?.away]].filter(([, v]) => prob(v) != null);
  if (!tiles.length) return null;
  return <Grid columns={tiles.length}>{tiles.map(([label, value]) => <ProbTile key={label} label={label} value={value} color={label === 'Empate' ? colors.warning : colors.accent} />)}</Grid>;
}

/** Frecuencias completas de baloncesto/fútbol americano: mismo documento que
 * MultisportAnalysisPage.js — cada bloque en tablas de columnas iguales. */
function MultisportFullFrequencies({ prediction, homeName, awayName, scoreLabel }: { prediction: any; homeName: string; awayName: string; scoreLabel: string }) {
  if (!prediction) return <AppText tone="muted">Todavía no hay frecuencias calculadas.</AppText>;
  return (
    <>
      <AccordionSection title="Resultado y proyección general" icon={<Trophy size={17} color={colors.accent} />}>
        <ExpectedRow value={prediction.expected} homeName={homeName} awayName={awayName} />
        <MoneylineTiles moneyline={prediction.moneyline} homeName={homeName} awayName={awayName} />
      </AccordionSection>
      <AccordionSection title={`Total del partido · ${scoreLabel}`} icon={<Sigma size={17} color={colors.cyan} />} accent={colors.cyan}>
        <OverUnderTable lines={prediction.totals?.lines} />
        <Panel title={`Total por equipo · ${scoreLabel}`}><CompareTable homeLines={prediction.teamTotals?.home} awayLines={prediction.teamTotals?.away} homeName={homeName} awayName={awayName} /></Panel>
      </AccordionSection>
      {prediction.spreads && (
        <AccordionSection title="Hándicaps calculados" icon={<Scale size={17} color={colors.warning} />} accent={colors.warning}>
          <SpreadColumns values={prediction.spreads} homeName={homeName} awayName={awayName} />
        </AccordionSection>
      )}
      {Object.keys(prediction.periods || {}).length > 0 && (
        <AccordionSection title="Análisis por periodo" icon={<Clock size={17} color="#818cf8" />} accent="#818cf8" count={Object.keys(prediction.periods).length}>
          {Object.entries<any>(prediction.periods).map(([key, period], index) => (
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
      {Object.keys(prediction.statistics || {}).length > 0 && (
        <AccordionSection title="Estadísticas de equipos" icon={<ChartColumn size={17} color="#f97316" />} accent="#f97316" count={Object.keys(prediction.statistics).length}>
          {Object.entries<any>(prediction.statistics).map(([key, values], index) => (
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

/** Marcador de cabecera para béisbol/multideporte: dos columnas idénticas. */
function SportHero({ kicker, homeName, awayName, homeLogo, awayLogo, homeScore, awayScore, homeProb, awayProb, startTime, badges }: {
  kicker: string; homeName: string; awayName: string; homeLogo?: string | null; awayLogo?: string | null; homeScore: any; awayScore: any;
  homeProb?: any; awayProb?: any; startTime?: string | null; badges?: Array<[string, string]>;
}) {
  const tz = getUserTz();
  const side = (label: string, name: string, logo: any, score: any, win: any) => (
    <View style={styles.heroSide}>
      <AppText variant="kicker" size={9.5} tone="faint">{label}</AppText>
      {logo !== undefined ? <TeamLogo src={logo} name={name} size={40} /> : null}
      <AppText variant="label" weight="bold" align="center" numberOfLines={2}>{name}</AppText>
      <AppText variant="mono" size={28} weight="bold" tone="accent">{score ?? '—'}</AppText>
      {prob(win) != null ? <AppText variant="caption" tone="accent" align="center">Gana {pctText(win)}</AppText> : null}
    </View>
  );
  return (
    <Card tone="accent" style={{ gap: 10 }}>
      <AppText variant="kicker" tone="muted" align="center" numberOfLines={1}>{kicker}</AppText>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {side('Local', homeName, homeLogo, homeScore, homeProb)}
        <AppText variant="kicker" tone="faint">VS</AppText>
        {side('Visitante', awayName, awayLogo, awayScore, awayProb)}
      </View>
      {startTime ? <AppText variant="caption" tone="muted" align="center">{fmtDateTime(startTime, tz)}</AppText> : null}
      {badges?.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 }}>
          {badges.map(([label, color]) => <View key={label} style={[styles.badge, { borderColor: `${color}66`, backgroundColor: `${color}1a` }]}><AppText variant="caption" weight="bold" style={{ color }}>{label}</AppText></View>)}
        </View>
      ) : null}
    </Card>
  );
}

/** Análisis completo de fútbol (mismo documento vertical que /dashboard/analisis/[id]). */
function FootballDetail({ id, date }: { id: string; date?: string }) {
  const [analysis, setAnalysis] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [notAnalyzed, setNotAnalyzed] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const liveStats = useFixtureLiveStats(id);
  const { selectedMarkets, toggleMarket } = useSelectedMarkets();
  const tz = getUserTz();

  const load = useCallback(async () => {
    setLoading(true); setError(''); setNotAnalyzed(false);
    try {
      const data = await api.get<any>(`/api/match/${id}?date=${date || todayInTz(tz)}`);
      setAnalysis(data.analysis);
      if (data.resultStats) setFixtureLiveStats(id, data.resultStats);
    } catch (cause: any) {
      if (cause instanceof ApiError && (cause.info as any)?.notFound) setNotAnalyzed(true);
      else setError(cause?.message || 'Error al cargar el análisis');
    } finally { setLoading(false); }
  }, [id, date, tz]);
  useEffect(() => { load(); }, [load]);

  const analyze = async () => {
    setAnalyzing(true); setError('');
    try {
      const data = await api.post<any>(`/api/match/${id}`, { action: 'analyze', date: date || todayInTz(tz) });
      setAnalysis(data.analysis); setNotAnalyzed(false);
    } catch (cause: any) { setError(cause?.message || 'No fue posible analizar este partido.'); }
    finally { setAnalyzing(false); }
  };

  const match = useMemo(() => analysis ? ({
    fixture: { id: Number(id), date: analysis.kickoff, status: liveStats?.status || analysis.status || { short: 'NS' } },
    league: { name: analysis.league, logo: analysis.leagueLogo, id: analysis.leagueId },
    teams: { home: { id: analysis.homeId, name: analysis.homeTeam, logo: analysis.homeLogo }, away: { id: analysis.awayId, name: analysis.awayTeam, logo: analysis.awayLogo } },
    goals: liveStats?.goals || analysis.goals,
  }) : null, [analysis, id, liveStats]);
  const markets = useMemo(() => match ? footballMarkets(analysis, match) : [], [analysis, match]);

  if (loading) return <View style={{ padding: 16 }}><SkeletonList count={4} height={140} /></View>;
  if (notAnalyzed) {
    return (
      <View style={{ padding: 16 }}>
        <Card style={{ alignItems: 'center', gap: 10 }}>
          <AppText variant="heading">Partido sin analizar</AppText>
          <AppText tone="muted" align="center">Este partido aún no tiene análisis. Puedes generarlo ahora.</AppText>
          {error ? <Banner tone="error" message={error} /> : null}
          <Button title={analyzing ? 'Analizando…' : 'Analizar partido'} loading={analyzing} onPress={analyze} icon={<Zap size={16} color={colors.onAccent} />} />
        </Card>
      </View>
    );
  }
  if (error && !analysis) return <View style={{ padding: 16 }}><Banner tone="error" message={error} /><Button title="Reintentar" variant="secondary" onPress={load} style={{ marginTop: 10 }} /></View>;
  if (!analysis || !match) return null;

  const a = analysis;
  const p = a.calculatedProbabilities;
  const selected = selectedMarkets[String(id)] || {};
  const matchName = `${a.homeTeam} vs ${a.awayTeam}`;
  const resultState = marketResultState({ sport: 'football', game: match, liveResult: liveStats });
  const pendingLabel = resultState.isLive ? 'En juego' : resultState.isFinal ? 'Pendiente oficial' : null;
  const lastFive = [[a.homeTeam, a.homeLastFive], [a.awayTeam, a.awayLastFive]].filter(([, list]) => Array.isArray(list) && list.length > 0) as Array<[string, any[]]>;

  return (
    <View style={styles.doc}>
      <MatchHeadCard match={match} odds={a.odds?.matchWinner} data={a} liveStats={liveStats} userTz={tz} />
      {a.leagueRound ? <AppText variant="caption" tone="muted" align="center">{a.leagueRound}</AppText> : null}
      {error ? <Banner tone="warning" message={error} /> : null}

      <AccordionSection title="Mercados para tu combinada" icon={<Layers size={17} color={colors.accent} />} count={markets.length} hint="Líneas con fiabilidad ≥90%, cuota real ≥1.20 y probabilidad ≥70%.">
        {markets.length ? markets.map((mkt: any) => (
          <MarketButton key={mkt.id} name={mkt.name} probability={Number(mkt.rawProbability ?? mkt.probability)} odd={mkt.odd} bookmaker={mkt.bookmaker} expectedValue={mkt.expectedValue} validation={mkt.recommended ? 'Recomendación estadística' : 'Dato estadístico'} selected={!!selected[mkt.id]} onPress={() => toggleMarket(id, { ...mkt, matchName }, matchName)} outcome={settleMarketSelection({ sport: 'football', selection: mkt, game: match, liveResult: liveStats })} pendingLabel={pendingLabel} />
        )) : <AppText tone="muted">Todavía no hay opciones que cumplan los criterios de recomendación.</AppText>}
      </AccordionSection>

      <AccordionSection title="XI Alineación titular" icon={<Users size={17} color={colors.cyan} />} accent={colors.cyan}>
        <LineupsSection id={String(id)} lineups={a.lineups} onRefreshed={(lineups) => setAnalysis((prev: any) => ({ ...prev, lineups }))} />
      </AccordionSection>

      <AccordionSection title="Bajas en el titular habitual" icon={<AlertTriangle size={17} color={colors.error} />} accent={colors.error}>
        <InjuriesSection id={String(id)} filteredInjuries={a.filteredInjuries} allInjuries={a.injuries} onRefreshed={(injuries) => setAnalysis((prev: any) => ({ ...prev, injuries }))} />
      </AccordionSection>

      {lastFive.length > 0 && (
        <AccordionSection title="Últimos 5 partidos" icon={<TrendingUp size={17} color="#22c55e" />} accent="#22c55e">
          {lastFive.map(([name, list]) => (
            <Panel key={name} title={name}>
              {list.map((m: any, i: number) => {
                // /api/match/[id] devuelve la forma cruda (_enriched), no el
                // resumen compacto {r,gF,gA,op} de la lista de "Analizados".
                const e = m._enriched || m;
                const result = e.result ?? m.r;
                const corners = (e.corners ?? m.c)?.total;
                const yellows = (e.yellowCards ?? m.y)?.total;
                return (
                  <View key={i} style={styles.lastRow}>
                    <View style={[styles.resultDot, { backgroundColor: result === 'W' ? colors.accent : result === 'L' ? colors.error : colors.warning }]}><AppText variant="mono" size={10} weight="bold" style={{ color: colors.onAccent }}>{result || '?'}</AppText></View>
                    <AppText variant="mono" size={12} style={{ width: 38 }}>{e.goalsFor ?? m.gF ?? '?'}-{e.goalsAgainst ?? m.gA ?? '?'}</AppText>
                    <AppText variant="caption" tone="secondary" style={{ flex: 1 }} numberOfLines={1}>vs {e.opponentName ?? m.op ?? '?'}</AppText>
                    <AppText variant="mono" size={11} tone="cyan" align="right" style={{ width: 34 }}>{corners != null ? `${corners}C` : '—'}</AppText>
                    <AppText variant="mono" size={11} tone="warning" align="right" style={{ width: 34 }}>{yellows != null ? `${yellows}T` : '—'}</AppText>
                  </View>
                );
              })}
            </Panel>
          ))}
          <AppText variant="caption" tone="faint">C = córners · T = tarjetas amarillas del partido.</AppText>
        </AccordionSection>
      )}

      {Array.isArray(a.h2h) && a.h2h.length > 0 && (
        <AccordionSection title="Historial H2H" icon={<History size={17} color="#a855f7" />} accent="#a855f7" count={Math.min(8, a.h2h.length)}>
          <H2HTable rows={a.h2h.slice(0, 8).map((h: any) => ({ date: h.fixture?.date, home: h.teams?.home?.name, away: h.teams?.away?.name, hs: h.goals?.home, as: h.goals?.away }))} />
        </AccordionSection>
      )}

      {p && (
        <AccordionSection title="Estadísticas calculadas" icon={<ChartColumn size={17} color="#f97316" />} accent="#f97316">
          <Panel title="Goles por partido">
            <Grid columns={2}>
              {[[a.homeTeam, p.homeGoals], [a.awayTeam, p.awayGoals]].map(([name, stats]: any) => (
                <View key={name} style={{ gap: 6 }}>
                  <AppText variant="caption" weight="bold" align="center" numberOfLines={1}>{name}</AppText>
                  <Grid columns={2} gap={6}>
                    <StatTile label="Anotados" value={stats?.avgScored ?? '—'} />
                    <StatTile label="Recibidos" value={stats?.avgConceded ?? '—'} color={colors.error} />
                  </Grid>
                </View>
              ))}
            </Grid>
          </Panel>
          <Panel title="Total combinado por partido">
            <Grid columns={2}>
              <StatTile label="Córners" value={p.cornerAvg ?? '—'} color={colors.cyan} />
              <StatTile label="Tarjetas" value={p.cardAvg ?? '—'} color={colors.warning} />
            </Grid>
          </Panel>
        </AccordionSection>
      )}

      {p?.goalTiming && (
        <AccordionSection title="Probabilidad de gol por periodo" icon={<Clock size={17} color="#818cf8" />} accent="#818cf8">
          <GoalTimingSection goalTiming={p.goalTiming} homeTeam={a.homeTeam} awayTeam={a.awayTeam} />
        </AccordionSection>
      )}

      {hasPlayerHighlights(a.playerHighlights) && (
        <AccordionSection title="Jugadores destacados" icon={<Star size={17} color="#fbbf24" />} accent="#fbbf24">
          <PlayersBlock highlights={a.playerHighlights} />
        </AccordionSection>
      )}

      <AccordionSection title="Frecuencias calculadas" icon={<Percent size={17} color="#2dd4bf" />} accent="#2dd4bf">
        <ProbBlock p={p} odds={a.odds} homeTeam={a.homeTeam} awayTeam={a.awayTeam} />
      </AccordionSection>

      <FinalVerdictPanel verdict={a.finalVerdict} homeName={a.homeTeam} awayName={a.awayTeam} />
    </View>
  );
}

/** Historial directo en columnas fijas: fecha | local | marcador | visitante. */
function H2HTable({ rows }: { rows: Array<{ date?: string; home?: string; away?: string; hs?: any; as?: any }> }) {
  return (
    <View style={{ gap: 0 }}>
      {rows.map((h, i) => (
        <View key={i} style={styles.h2hRow}>
          <AppText variant="caption" tone="faint" style={{ width: 62 }}>{h.date ? new Date(h.date).toLocaleDateString('es', { day: '2-digit', month: 'short', year: '2-digit' }) : ''}</AppText>
          <AppText variant="caption" align="right" style={{ flex: 1 }} numberOfLines={1}>{h.home}</AppText>
          <AppText variant="mono" size={12} weight="bold" tone="accent" align="center" style={{ width: 50 }}>{h.hs ?? '-'}–{h.as ?? '-'}</AppText>
          <AppText variant="caption" style={{ flex: 1 }} numberOfLines={1}>{h.away}</AppText>
        </View>
      ))}
    </View>
  );
}

const PLAYER_CATEGORY_LABELS: Record<string, string> = {
  hits: 'Hits', homeRuns: 'Jonrones', totalBases: 'Bases totales', rbis: 'Carreras impulsadas', runs: 'Carreras anotadas',
  walks: 'Bases por bolas', stolenBases: 'Bases robadas', strikeouts: 'Ponches del lanzador', battingStrikeouts: 'Ponches del bateador',
};

/** Bateadores y lanzadores: un acordeón por categoría (las 2 primeras abiertas, como la web). */
function BaseballPlayers({ players }: { players: any }) {
  const rows = Object.entries<any>(players || {}).filter(([, entries]) => Array.isArray(entries) && entries.length);
  if (!rows.length) return null;
  return (
    <AccordionSection title="Bateadores y lanzadores" icon={<Users size={17} color="#a78bfa" />} accent="#a78bfa" count={rows.length} hint="Cada porcentaje sale del registro partido a partido del jugador. Este bloque no depende de que exista una cuota.">
      {rows.map(([category, entries], index) => (
        <SubAccordion key={category} title={PLAYER_CATEGORY_LABELS[category] || category} meta={`${entries.length} jugadores`} defaultOpen={index < 2}>
          {entries.map((player: any) => (
            <Panel key={`${category}-${player.id || player.name}`}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {player.photo ? <Image source={{ uri: player.photo }} style={styles.playerPhoto} contentFit="cover" /> : null}
                <View style={{ flex: 1 }}>
                  <AppText variant="label" weight="bold" numberOfLines={1}>{player.name}</AppText>
                  <AppText variant="caption" tone="muted" numberOfLines={1}>{player.teamName || 'MLB'} · media {numText(player.mean)} · {player.history?.length || 0} partidos</AppText>
                </View>
              </View>
              <OverUnderTable lines={Object.fromEntries(Object.entries<any>(player.lineSides || {}).map(([line, sides]) => [line, { over: sides.over?.probability, under: sides.under?.probability }]))} />
              {player.history?.length > 0 && <AppText variant="caption" tone="faint">Últimos registros: {player.history.slice(-10).reverse().join(' · ')}</AppText>}
            </Panel>
          ))}
        </SubAccordion>
      ))}
    </AccordionSection>
  );
}

/** Situaciones especiales: malla de 2 columnas + acordeón con marcadores. */
function BaseballSpecials({ specials, homeName, awayName }: { specials: any; homeName: string; awayName: string }) {
  if (!specials || !Object.keys(specials).length) return null;
  const pairs: Array<[string, any, string, any]> = [
    ['Total impar', specials.totalParity?.odd, 'Total par', specials.totalParity?.even],
    [`${homeName} anota primero`, specials.firstTeamScore?.home, `${awayName} anota primero`, specials.firstTeamScore?.away],
    [`${homeName} anota último`, specials.lastTeamScore?.home, `${awayName} anota último`, specials.lastTeamScore?.away],
    ['Habrá entradas extra', specials.extraInnings?.yes, 'Sin entradas extra', specials.extraInnings?.no],
    [`${homeName}: impares`, specials.teamParity?.home?.odd, `${homeName}: pares`, specials.teamParity?.home?.even],
    [`${awayName}: impares`, specials.teamParity?.away?.odd, `${awayName}: pares`, specials.teamParity?.away?.even],
    [`${homeName} con más carreras`, specials.highestScoring?.home, `${awayName} con más carreras`, specials.highestScoring?.away],
  ].filter(([, l, , r]) => prob(l) != null || prob(r) != null) as any;
  const detailed = [
    ...Object.entries<any>(specials.correctScore || {}).map(([key, value]) => [`Marcador exacto ${key}`, value]),
    ...Object.entries<any>(specials.halfFull || {}).map(([key, value]) => [`Primeras 5 / final: ${displayBettingText(key)}`, value]),
    ...Object.entries<any>(specials.resultTotals || {}).map(([key, value]) => [`Resultado y carreras: ${displayBettingText(key)}`, value]),
  ].filter(([, value]) => prob(value) != null);
  if (!pairs.length && !detailed.length) return null;
  return (
    <AccordionSection title="Situaciones especiales" icon={<Sparkles size={17} color="#f472b6" />} accent="#f472b6">
      {pairs.map(([l, lv, r, rv]) => (
        <Grid key={l} columns={2}>
          <StatTile label={l} value={pctText(lv)} />
          <StatTile label={r} value={pctText(rv)} color={colors.warning} />
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

/** Análisis completo de béisbol: /api/baseball/match/[id] — mismas secciones que la web. */
function BaseballDetail({ id }: { id: string }) {
  const [payload, setPayload] = useState<any>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    api.get<any>(`/api/baseball/match/${id}`).then((json) => { if (active) { setPayload(json); setError(''); } }).catch((cause) => { if (active) setError(cause?.message || 'No fue posible cargar el análisis'); });
    return () => { active = false; };
  }, [id, reload]);
  if (error && !payload) return <View style={{ padding: 16, gap: 10 }}><Banner tone="error" message={error} /><Button title="Reintentar" variant="secondary" onPress={() => setReload((n) => n + 1)} /></View>;
  if (!payload) return <View style={{ padding: 16 }}><SkeletonList count={4} height={140} /></View>;
  const a = payload.analysis;
  const result = payload.result;
  const probs = a?.probabilities;
  const combinada = a?.combinada;
  const dq = a?.data_quality;
  const markets: any[] = (Array.isArray(combinada?.selectable) ? combinada.selectable : []).filter(bet365Market).sort((l: any, r: any) => Number(r.rawProbability ?? r.probability) - Number(l.rawProbability ?? l.probability) || Number(r.odd) - Number(l.odd));
  const highlighted: any[] = (Array.isArray(combinada?.selections) ? combinada.selections : []).filter(bet365Market);
  const homeName = a?.home_team || 'Local';
  const awayName = a?.away_team || 'Visitante';
  const game = { id: Number(id), teams: { home: { name: homeName }, away: { name: awayName } }, status: { short: result?.status || a?.status }, liveResult: result, analysis: a };
  const state = marketResultState({ sport: 'baseball', game, liveResult: result });
  const badges: Array<[string, string]> = dq ? [
    [`Calidad: ${dq.score}%`, dq.score >= 75 ? '#10b981' : dq.score >= 50 ? '#f59e0b' : '#ef4444'] as [string, string],
    ...(dq.hasOdds ? [['Cuotas Bet365', '#22d3ee'] as [string, string]] : []),
    ...(dq.hasH2H ? [['H2H', '#8b5cf6'] as [string, string]] : []),
    ...(dq.hasHomeStats && dq.hasAwayStats ? [['Stats', '#10b981'] as [string, string]] : []),
    ...(dq.hasPitcherMatchup ? [['Pitcher', '#f59e0b'] as [string, string]] : []),
    ...(dq.hasPlayerHighlights ? [['Players', '#a78bfa'] as [string, string]] : []),
  ] : [];
  const periods = Object.entries<any>(probs?.periods || {}).filter(([key]) => !/^inning\d+$/.test(key));
  const innings = Object.entries<any>(probs?.innings || {}).sort((l, r) => Number(l[0]) - Number(r[0]));
  const statistics = Object.entries<any>(probs?.statistics || {});
  const pitchers = probs?.pitchers || a?.analysis?.pitcherMatchup;
  const pitcherSides = (['home', 'away'] as const).filter((side) => pitchers?.[side]);
  const expected = probs?.expected;
  return (
    <View style={styles.doc}>
      <SportHero kicker={`Béisbol · ${a?.country || ''} · ${a?.league_name || ''}`} homeName={homeName} awayName={awayName} homeScore={result?.home_score} awayScore={result?.away_score} homeProb={probs?.moneyline?.home} awayProb={probs?.moneyline?.away} startTime={a?.start_time} badges={badges} />

      {result?.home_score != null && result?.away_score != null && (
        <AccordionSection title={result.status === 'FT' ? 'Resultado oficial MLB' : 'Estadísticas en vivo MLB'} icon={<Activity size={17} color={colors.cyan} />} accent={colors.cyan}>
          <BaseballResultStats result={result} homeName={homeName} awayName={awayName} />
        </AccordionSection>
      )}

      {highlighted.length > 0 && Number(combinada?.combinedProbability) >= 60 && (
        <AccordionSection title="Combinada Bet365 del partido" icon={<Layers size={17} color={colors.accent} />} count={highlighted.length}>
          {highlighted.map((s, i) => (
            <View key={i} style={styles.comboRow}>
              <View style={{ flex: 1 }}>
                <AppText variant="caption" tone="muted" numberOfLines={1}>{s.marketLabel || s.market}</AppText>
                <AppText variant="label" weight="bold">{displayBettingText(s.pick || s.name)}</AppText>
              </View>
              <AppText variant="mono" size={13} weight="bold" tone="accent" align="right" style={{ width: 62 }}>{cap(s.rawProbability ?? s.probability)}%</AppText>
              <AppText variant="mono" size={13} align="right" style={{ width: 52, color: colors.amber }}>@{Number(s.odd).toFixed(2)}</AppText>
            </View>
          ))}
          <Grid columns={2}>
            <StatTile label="Probabilidad combinada" value={`${cap(combinada.combinedProbability)}%`} />
            <StatTile label="Cuota combinada" value={combinada.combinedOdd ? `@${combinada.combinedOdd}` : '—'} color={colors.cyan} />
          </Grid>
        </AccordionSection>
      )}

      <AccordionSection title="Opciones disponibles en Bet365" icon={<Layers size={17} color={colors.accent} />} count={markets.length} hint="Línea exacta de Bet365, probabilidad mínima del 65% y cuota mínima de 1,20.">
        {markets.length ? markets.map((m) => (
          <MarketButton key={m.id} name={m.name || m.pick} probability={Number(m.rawProbability ?? m.probability)} odd={m.odd} bookmaker={m.bookmaker} reliability={m.reliability} validation={m.marketLabel || m.market} outcome={settleMarketSelection({ sport: 'baseball', selection: m, game, liveResult: result })} pendingLabel={state.isLive ? 'En juego' : state.isFinal ? 'Pendiente oficial' : null} />
        )) : <AppText tone="muted">Bet365 no tiene ahora una línea exacta que cumpla ambos criterios. El análisis estadístico completo permanece visible.</AppText>}
      </AccordionSection>

      {pitcherSides.length > 0 && (
        <AccordionSection title="Lanzadores abridores" icon={<Target size={17} color={colors.warning} />} accent={colors.warning}>
          <Grid columns={2}>
            {(['home', 'away'] as const).map((side) => {
              const pitcher = pitchers?.[side];
              return (
                <Panel key={side} title={side === 'home' ? homeName : awayName}>
                  <AppText variant="label" weight="bold" numberOfLines={1}>{pitcher?.name || 'Por confirmar'}</AppText>
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
        <AccordionSection title="Análisis estadístico completo" icon={<Sigma size={17} color={colors.accent} />} hint="Todo lo calculado con los antecedentes reales; las cuotas solo determinan qué opciones pasan a la sección apostable.">
          {expected && (
            <Grid columns={3}>
              <StatTile label={homeName} value={numText(expected.lambdaHome)} sub="carreras" />
              <StatTile label="Total" value={numText(expected.totalRuns)} color={colors.cyan} sub="carreras" />
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
        <AccordionSection title="Tramos acumulados del partido" icon={<Clock size={17} color="#818cf8" />} accent="#818cf8" count={periods.length}>
          {periods.map(([key, period], index) => (
            <SubAccordion key={key} title={period.label || PERIOD_LABELS[key] || key} defaultOpen={index === 0}>
              <MoneylineTiles moneyline={period.moneyline} homeName={homeName} awayName={awayName} />
              <OverUnderTable lines={period.totals} />
            </SubAccordion>
          ))}
        </AccordionSection>
      )}

      {innings.length > 0 && (
        <AccordionSection title="Análisis entrada por entrada" icon={<ListOrdered size={17} color="#2dd4bf" />} accent="#2dd4bf" count={innings.length} hint="Las nueve entradas se calculan con el historial real disponible, aunque Bet365 no tenga cuota para esa entrada.">
          {innings.map(([inning, values], index) => (
            <SubAccordion key={inning} title={`${inning}.ª entrada`} meta={`media ${numText(values.expected?.total)}`} defaultOpen={index === 0}>
              <Grid columns={2}>
                <ProbTile label="Habrá carrera" value={values.run?.yes} />
                <ProbTile label="Sin carrera" value={values.run?.no} color={colors.warning} />
                <ProbTile label={`${homeName} anota`} value={values.teamTotals?.home?.['0.5']?.over} />
                <ProbTile label={`${awayName} anota`} value={values.teamTotals?.away?.['0.5']?.over} />
              </Grid>
              <OverUnderTable lines={values.totals} />
            </SubAccordion>
          ))}
        </AccordionSection>
      )}

      {statistics.length > 0 && (
        <AccordionSection title="Estadísticas de equipos" icon={<ChartColumn size={17} color="#f97316" />} accent="#f97316" count={statistics.length}>
          {statistics.map(([key, values], index) => (
            <SubAccordion key={key} title={values.label || key} defaultOpen={index < 2}>
              <CompareTable homeLines={values.home} awayLines={values.away} homeName={homeName} awayName={awayName} />
            </SubAccordion>
          ))}
        </AccordionSection>
      )}

      <BaseballSpecials specials={probs?.specials} homeName={homeName} awayName={awayName} />

      {Array.isArray(a?.analysis?.h2h) && a.analysis.h2h.length > 0 && (
        <AccordionSection title="Últimos enfrentamientos (H2H)" icon={<History size={17} color="#a855f7" />} accent="#a855f7" count={Math.min(6, a.analysis.h2h.length)}>
          <H2HTable rows={a.analysis.h2h.slice(0, 6).map((h: any) => ({ date: h.date, home: h.teams?.home?.name, away: h.teams?.away?.name, hs: h.scores?.home?.total ?? h.scores?.home, as: h.scores?.away?.total ?? h.scores?.away }))} />
        </AccordionSection>
      )}

      <FinalVerdictPanel verdict={a?.analysis?.finalVerdict} homeName={homeName} awayName={awayName} />
      <Button title="Refrescar" variant="secondary" onPress={() => setReload((n) => n + 1)} icon={<RefreshCw size={15} color={colors.accent} />} />
    </View>
  );
}

/** Baloncesto y fútbol americano: /api/sports/[sport]/match/[id]. */
function MultisportDetail({ sport, id }: { sport: string; id: string }) {
  const [payload, setPayload] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api.get<any>(`/api/sports/${sport}/match/${encodeURIComponent(id)}`).then((json) => { if (active) setPayload(json); }).catch((cause) => { if (active) setError(cause?.message || 'No fue posible cargar el análisis'); });
    return () => { active = false; };
  }, [sport, id]);
  if (error) return <View style={{ padding: 16 }}><Banner tone="error" message={error} /></View>;
  if (!payload) return <View style={{ padding: 16 }}><SkeletonList count={4} height={140} /></View>;
  const analysis = payload.analysis;
  const match = payload.match;
  const homeName = analysis?.home_team || match?.home_team || 'Local';
  const awayName = analysis?.away_team || match?.away_team || 'Visitante';
  const markets: any[] = (analysis?.combinada?.selectable || []).filter(bet365Market).sort((l: any, r: any) => Number(r.rawProbability ?? r.probability) - Number(l.rawProbability ?? l.probability) || Number(r.odd) - Number(l.odd));
  const game = { id, teams: { home: { name: homeName }, away: { name: awayName } }, status: { short: match?.status }, liveResult: match, analysis };
  const prediction = analysis?.probabilities?.evidence || analysis?.probabilities;
  return (
    <View style={styles.doc}>
      <SportHero kicker={`${SPORT_LABEL[sport] || sport} · ${analysis?.league_name || ''}`} homeName={homeName} awayName={awayName} homeLogo={match?.home_logo ?? null} awayLogo={match?.away_logo ?? null} homeScore={match?.home_score} awayScore={match?.away_score} homeProb={prediction?.moneyline?.home} awayProb={prediction?.moneyline?.away} startTime={analysis?.start_time} />
      <AccordionSection title="Arma tu combinada · Bet365" icon={<Layers size={17} color={colors.accent} />} count={markets.length} hint="Línea exacta de Bet365, probabilidad mínima del 65% y cuota mínima de 1,20.">
        {markets.length ? markets.map((market) => (
          <MarketButton key={market.id} name={market.name || market.pick} probability={Number(market.rawProbability ?? market.probability)} odd={market.odd} bookmaker={market.bookmaker} reliability={market.reliability} validation={displayBettingText(market.marketLabel || market.market || '')} outcome={settleMarketSelection({ sport, selection: market, game, liveResult: match })} pendingLabel={null} />
        )) : <AppText tone="muted">Bet365 no tiene ahora una línea exacta que cumpla ambos criterios. El análisis estadístico completo permanece visible.</AppText>}
      </AccordionSection>
      <MultisportFullFrequencies prediction={prediction} homeName={homeName} awayName={awayName} scoreLabel="puntos" />
      <FinalVerdictPanel verdict={analysis?.analysis?.finalVerdict} homeName={homeName} awayName={awayName} />
    </View>
  );
}

export default function MatchDetailScreen() {
  const { sport = 'football', id = '', date } = useLocalSearchParams<{ sport: string; id: string; date?: string }>();
  const router = useRouter();
  const { isFree } = useAccess();
  const back = () => (router.canGoBack() ? router.back() : router.replace('/dashboard'));
  const title = `${SPORT_LABEL[sport] || sport} · análisis completo`;
  return (
    <Screen>
      <Header onBack={back} title={title} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {isFree ? <View style={{ padding: 16 }}><LockedAnalysis title="Análisis completo" /></View>
          : sport === 'football' ? <FootballDetail id={String(id)} date={date} />
            : sport === 'baseball' ? <BaseballDetail id={String(id)} />
              : <MultisportDetail sport={String(sport)} id={String(id)} />}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  back: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: colors.border },
  playerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 },
  doc: { padding: 12, gap: 12 },
  lastRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: colors.border },
  resultDot: { width: 20, height: 20, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  h2hRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.border },
  heatTable: { gap: 8 },
  heatRow: { flexDirection: 'row', gap: 4 },
  heatCell: { flex: 1, alignItems: 'center', justifyContent: 'center', height: 32, borderRadius: 7, paddingHorizontal: 2 },
  heroSide: { flex: 1, alignItems: 'center', gap: 3 },
  badge: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.pill, borderWidth: 1 },
  comboRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: radius.sm, backgroundColor: 'rgba(94,230,177,0.06)' },
  playerPhoto: { width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.05)' },
});
