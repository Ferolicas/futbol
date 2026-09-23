import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { AlertTriangle, ChevronLeft, Zap } from 'lucide-react-native';
import { AppText, Banner, Button, Card, Screen, SkeletonList, TeamLogo } from '@/components/ui';
import { MatchHeadCard } from '@/components/dashboard/MatchHeadCard';
import { toHeadMatch } from '@/components/dashboard/SportGameCard';
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

function Section({ title, children, hint }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <AppText variant="heading">{title}</AppText>
      {hint ? <AppText variant="caption" tone="muted">{hint}</AppText> : null}
      {children}
    </View>
  );
}

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

/** Probabilidad de gol por periodo de 15' — mismo goalTiming que la web, en heatmap. */
function GoalTimingSection({ goalTiming, homeTeam, awayTeam }: { goalTiming: any; homeTeam: string; awayTeam: string }) {
  const periods = ['0-15', '15-30', '30-45', '45-60', '60-75', '75-90'];
  const at = (data: any[], i: number) => cap(data?.[i]?.probability || 0);
  return (
    <View style={{ gap: 10 }}>
      {[['Combinado', goalTiming.combined], [homeTeam, goalTiming.home], [awayTeam, goalTiming.away]].map(([label, data]: any) => (
        <Card key={label} style={{ gap: 6 }}>
          <AppText variant="kicker" tone="muted" numberOfLines={1}>{label}</AppText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {periods.map((p, i) => {
              const value = at(data, i);
              const heat = heatmapColor(value);
              return (
                <View key={p} style={{ alignItems: 'center', minWidth: 46, borderRadius: 8, paddingVertical: 4, backgroundColor: heat.background }}>
                  <AppText variant="caption" style={{ color: heat.color, opacity: 0.85 }}>{p}&apos;</AppText>
                  <AppText variant="mono" size={12} weight="bold" style={{ color: heat.color }}>{value}%</AppText>
                </View>
              );
            })}
          </View>
        </Card>
      ))}
    </View>
  );
}

const MSF_PERIOD_LABELS: Record<string, string> = {
  firstHalf: 'Primera mitad', secondHalf: 'Segunda mitad', quarter1: 'Primer cuarto', quarter2: 'Segundo cuarto',
  quarter3: 'Tercer cuarto', quarter4: 'Cuarto cuarto', first3: 'Primeras 3 entradas', first4_5: 'Primeras 4,5 entradas',
  first5: 'Primeras 5 entradas', first7: 'Primeras 7 entradas',
};
const msfProb = (entry: any): number | null => {
  const raw = Number(entry?.rawProbability);
  if (Number.isFinite(raw)) return raw <= 1 ? raw * 100 : raw;
  const value = Number(entry?.probability ?? entry);
  return Number.isFinite(value) ? value : null;
};
const msfPct = (entry: any) => { const v = msfProb(entry); return v == null ? '—' : `${Math.min(95, v).toFixed(2).replace(/\.00$/, '')}%`; };
const msfFmt = (value: any) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2);

function MsfPill({ label, value }: { label: string; value: any }) {
  if (msfProb(value) == null) return null;
  return <View style={styles.msfPill}><AppText variant="caption" tone="muted">{label}</AppText><AppText variant="mono" size={12} weight="bold" tone="accent">{msfPct(value)}</AppText></View>;
}
// Malla simétrica (línea + más%/menos%) en vez de la lista vertical infinita.
function MsfMesh({ lines, label = 'puntos' }: { lines: any; label?: string }) {
  const entries = Object.entries(lines || {}).sort((l, r) => Number(l[0]) - Number(r[0]));
  if (!entries.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {entries.map(([line, values]: any) => (
        <View key={line} style={styles.msfMeshCell}>
          <AppText variant="caption" weight="bold" align="center" numberOfLines={1}>{line} {label}</AppText>
          <AppText variant="caption" tone="accent" align="center">Más {msfPct(values?.over)}</AppText>
          <AppText variant="caption" tone="warning" align="center">Menos {msfPct(values?.under)}</AppText>
        </View>
      ))}
    </View>
  );
}
// Una sola tarjeta por estadística: columna de líneas + columna por equipo
// con su porcentaje, en vez de 2-3 ladders sueltos por equipo/total.
function MsfComparisonCard({ title, homeLines, awayLines, homeName, awayName }: { title?: string; homeLines: any; awayLines: any; homeName: string; awayName: string }) {
  const allLines = [...new Set([...Object.keys(homeLines || {}), ...Object.keys(awayLines || {})])]
    .map(Number).filter(Number.isFinite).sort((l, r) => l - r);
  if (!allLines.length) return null;
  return (
    <Card style={{ gap: 8 }}>
      {title ? <AppText variant="kicker" tone="muted" numberOfLines={1}>{title}</AppText> : null}
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <View style={{ flex: 1.1 }} />
        <AppText variant="caption" weight="bold" align="center" style={{ flex: 1 }} numberOfLines={1}>{homeName}</AppText>
        <AppText variant="caption" weight="bold" align="center" style={{ flex: 1 }} numberOfLines={1}>{awayName}</AppText>
      </View>
      {allLines.map((line) => (
        <View key={line} style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          <AppText variant="caption" tone="secondary" style={{ flex: 1.1 }}>Línea {line}</AppText>
          <AppText variant="mono" size={12} tone="accent" align="center" style={{ flex: 1 }}>{msfPct(homeLines?.[line]?.over)}</AppText>
          <AppText variant="mono" size={12} tone="accent" align="center" style={{ flex: 1 }}>{msfPct(awayLines?.[line]?.over)}</AppText>
        </View>
      ))}
    </Card>
  );
}
function MsfExpected({ value, homeName, awayName }: { value: any; homeName: string; awayName: string }) {
  if (!value || !Object.values(value).some((v) => v != null)) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {[[homeName, value.home], ['Total', value.total], [awayName, value.away]].map(([label, v]: any) => (
        <Card key={label} style={{ flex: 1, alignItems: 'center', gap: 2 }}>
          <AppText variant="caption" tone="muted" numberOfLines={1}>{label}</AppText>
          <AppText variant="mono" size={16} weight="bold" tone="accent">{msfFmt(v)}</AppText>
        </Card>
      ))}
    </View>
  );
}
// Columna por equipo (sin repetir el nombre en cada renglón) en vez de una
// lista plana mezclando ambos equipos.
function MsfSpreads({ values, homeName, awayName }: { values: any; homeName: string; awayName: string }) {
  const homeEntries = Object.entries(values?.home || {}).sort((l, r) => Number(l[0]) - Number(r[0]));
  const awayEntries = Object.entries(values?.away || {}).sort((l, r) => Number(l[0]) - Number(r[0]));
  if (!homeEntries.length && !awayEntries.length) return null;
  const Column = ({ name, entries }: { name: string; entries: [string, any][] }) => (
    <View style={{ flex: 1, gap: 6, minWidth: 130 }}>
      <AppText variant="kicker" tone="muted" numberOfLines={1}>{name}</AppText>
      {entries.map(([line, value]) => (
        <View key={line} style={styles.msfSpreadRow}>
          <AppText variant="caption" tone="secondary">{Number(line) > 0 ? '+' : ''}{line}</AppText>
          <AppText variant="mono" size={12} tone="accent">{msfPct(value)}</AppText>
        </View>
      ))}
    </View>
  );
  return <View style={{ flexDirection: 'row', gap: 10 }}><Column name={homeName} entries={homeEntries} /><Column name={awayName} entries={awayEntries} /></View>;
}

/** Frecuencias calculadas completas (baseball/basketball/NFL): mismo
 * documento que MultisportAnalysisPage.js en la web — moneyline, totales,
 * hándicaps y CADA periodo/estadística con su propio desglose, no solo el
 * resumen simplificado que usa la tarjeta del dashboard. */
function MultisportFullFrequencies({ prediction, homeName, awayName, scoreLabel }: { prediction: any; homeName: string; awayName: string; scoreLabel: string }) {
  if (!prediction) return <AppText tone="muted">Todavía no hay frecuencias calculadas.</AppText>;
  return (
    <View style={{ gap: 14 }}>
      <Card style={{ gap: 10 }}>
        <AppText variant="kicker" tone="muted">Resultado y proyección general</AppText>
        <MsfExpected value={prediction.expected} homeName={homeName} awayName={awayName} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <MsfPill label={`${homeName} gana`} value={prediction.moneyline?.home} />
          <MsfPill label="Empate" value={prediction.moneyline?.draw} />
          <MsfPill label={`${awayName} gana`} value={prediction.moneyline?.away} />
        </View>
      </Card>
      <Card style={{ gap: 10 }}>
        <AppText variant="kicker" tone="muted">Total del partido</AppText>
        <MsfMesh lines={prediction.totals?.lines} label={scoreLabel} />
      </Card>
      <MsfComparisonCard title={`Total — ${scoreLabel}`} homeLines={prediction.teamTotals?.home} awayLines={prediction.teamTotals?.away} homeName={homeName} awayName={awayName} />
      {prediction.spreads && (
        <Card style={{ gap: 8 }}>
          <AppText variant="kicker" tone="muted">Hándicaps calculados</AppText>
          <MsfSpreads values={prediction.spreads} homeName={homeName} awayName={awayName} />
        </Card>
      )}
      {Object.entries<any>(prediction.periods || {}).map(([key, period]) => (
        <Card key={key} style={{ gap: 10 }}>
          <AppText variant="kicker" tone="muted">{period.label || MSF_PERIOD_LABELS[key] || key}</AppText>
          <MsfExpected value={period.expected} homeName={homeName} awayName={awayName} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <MsfPill label={`${homeName} gana`} value={period.moneyline?.home} />
            <MsfPill label="Empate" value={period.moneyline?.draw} />
            <MsfPill label={`${awayName} gana`} value={period.moneyline?.away} />
          </View>
          <MsfMesh lines={period.totals} label={scoreLabel} />
          <MsfComparisonCard homeLines={period.teamTotals?.home} awayLines={period.teamTotals?.away} homeName={homeName} awayName={awayName} />
          <MsfSpreads values={period.spreads} homeName={homeName} awayName={awayName} />
        </Card>
      ))}
      {Object.entries<any>(prediction.statistics || {}).map(([key, values]) => (
        <View key={key} style={{ gap: 10 }}>
          <MsfExpected value={values.expected} homeName={homeName} awayName={awayName} />
          <MsfComparisonCard title={values.label || key} homeLines={values.home} awayLines={values.away} homeName={homeName} awayName={awayName} />
        </View>
      ))}
    </View>
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

  return (
    <View style={{ padding: 16, gap: 18 }}>
      <MatchHeadCard match={match} odds={a.odds?.matchWinner} data={a} liveStats={liveStats} userTz={tz} />
      {a.leagueRound ? <AppText variant="caption" tone="muted" align="center">{a.leagueRound}</AppText> : null}
      {error ? <Banner tone="warning" message={error} /> : null}

      <Section title="Mercados para tu combinada" hint="Líneas con fiabilidad ≥90%, cuota real ≥1.20 y probabilidad ≥70%.">
        {markets.length ? markets.map((mkt: any) => (
          <MarketButton key={mkt.id} name={mkt.name} probability={Number(mkt.rawProbability ?? mkt.probability)} odd={mkt.odd} bookmaker={mkt.bookmaker} expectedValue={mkt.expectedValue} validation={mkt.recommended ? 'Recomendación estadística' : 'Dato estadístico'} selected={!!selected[mkt.id]} onPress={() => toggleMarket(id, { ...mkt, matchName }, matchName)} outcome={settleMarketSelection({ sport: 'football', selection: mkt, game: match, liveResult: liveStats })} pendingLabel={pendingLabel} />
        )) : <AppText tone="muted">Todavía no hay opciones que cumplan los criterios de recomendación.</AppText>}
      </Section>

      <Section title="Bajas en el titular habitual">
        <InjuriesSection id={String(id)} filteredInjuries={a.filteredInjuries} allInjuries={a.injuries} onRefreshed={(injuries) => setAnalysis((prev: any) => ({ ...prev, injuries }))} />
      </Section>

      <Section title="XI Alineación titular">
        <LineupsSection id={String(id)} lineups={a.lineups} onRefreshed={(lineups) => setAnalysis((prev: any) => ({ ...prev, lineups }))} />
      </Section>

      {p && (
        <Section title="Estadísticas calculadas">
          <Card style={{ gap: 12 }}>
            <AppText variant="label" weight="bold" align="center">Goles</AppText>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[[a.homeTeam, p.homeGoals], [a.awayTeam, p.awayGoals]].map(([name, stats]: any) => (
                <View key={name} style={{ flex: 1, gap: 4 }}>
                  <AppText variant="kicker" tone="muted" numberOfLines={1}>{name}</AppText>
                  <AppText variant="caption" tone="secondary">Anotados <AppText variant="mono" size={12} tone="accent">{stats?.avgScored ?? '—'}</AppText></AppText>
                  <AppText variant="caption" tone="secondary">Recibidos <AppText variant="mono" size={12} tone="error">{stats?.avgConceded ?? '—'}</AppText></AppText>
                </View>
              ))}
            </View>
            <View style={{ height: 1, backgroundColor: colors.border }} />
            <AppText variant="label" weight="bold" align="center">Total combinado</AppText>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1, alignItems: 'center', gap: 2 }}>
                <AppText variant="mono" size={18} tone="cyan">{p.cornerAvg ?? '—'}</AppText>
                <AppText variant="caption" tone="faint">Corners</AppText>
              </View>
              <View style={{ flex: 1, alignItems: 'center', gap: 2 }}>
                <AppText variant="mono" size={18} tone="warning">{p.cardAvg ?? '—'}</AppText>
                <AppText variant="caption" tone="faint">Tarjetas</AppText>
              </View>
            </View>
          </Card>
        </Section>
      )}

      {p?.goalTiming && (
        <Section title="Probabilidad de gol por periodo">
          <GoalTimingSection goalTiming={p.goalTiming} homeTeam={a.homeTeam} awayTeam={a.awayTeam} />
        </Section>
      )}

      <Section title="Frecuencias calculadas">
        <ProbBlock p={p} odds={a.odds} homeTeam={a.homeTeam} awayTeam={a.awayTeam} />
      </Section>

      {hasPlayerHighlights(a.playerHighlights) && (
        <Section title="Jugadores destacados"><PlayersBlock highlights={a.playerHighlights} /></Section>
      )}

      {(Array.isArray(a.homeLastFive) && a.homeLastFive.length > 0) || (Array.isArray(a.awayLastFive) && a.awayLastFive.length > 0) ? (
        <Section title="Últimos 5 partidos">
          {[[a.homeTeam, a.homeLastFive], [a.awayTeam, a.awayLastFive]].map(([name, list]: any) => Array.isArray(list) && list.length > 0 ? (
            <Card key={name} style={{ gap: 4 }}>
              <AppText variant="kicker" tone="muted">{name}</AppText>
              {list.map((m: any, i: number) => {
                // /api/match/[id] devuelve la forma cruda (_enriched), no el
                // resumen compacto {r,gF,gA,op} que arma compactLastFive()
                // para la lista de "Analizados" — por eso salía todo "?".
                const e = m._enriched || m;
                const result = e.result ?? m.r;
                const goalsFor = e.goalsFor ?? m.gF;
                const goalsAgainst = e.goalsAgainst ?? m.gA;
                const opponent = e.opponentName ?? m.op;
                const corners = e.corners ?? m.c;
                const yellows = e.yellowCards ?? m.y;
                return (
                  <View key={i} style={styles.lastRow}>
                    <AppText variant="mono" size={11} weight="bold" style={{ width: 16, color: result === 'W' ? colors.accent : result === 'L' ? colors.error : colors.warning }}>{result || '?'}</AppText>
                    <AppText variant="mono" size={12} style={{ width: 40 }}>{goalsFor ?? '?'}-{goalsAgainst ?? '?'}</AppText>
                    <AppText variant="caption" tone="secondary" style={{ flex: 1 }} numberOfLines={1}>vs {opponent || '?'}</AppText>
                    {corners?.total != null && <AppText variant="caption" tone="cyan">{corners.total} córners</AppText>}
                    {yellows?.total != null && <AppText variant="caption" tone="warning">{yellows.total} amarillas</AppText>}
                  </View>
                );
              })}
            </Card>
          ) : null)}
        </Section>
      ) : null}

      {Array.isArray(a.h2h) && a.h2h.length > 0 && (
        <Section title="Enfrentamientos directos">
          <Card style={{ gap: 6 }}>
            {a.h2h.slice(0, 8).map((h: any, i: number) => (
              <View key={i} style={styles.lastRow}>
                <AppText variant="caption" tone="muted" style={{ width: 70 }}>{h.fixture?.date ? new Date(h.fixture.date).toLocaleDateString('es', { day: '2-digit', month: 'short', year: '2-digit' }) : ''}</AppText>
                <AppText variant="caption" style={{ flex: 1 }} numberOfLines={1}>{h.teams?.home?.name} <AppText variant="mono" size={12}>{h.goals?.home ?? '-'}–{h.goals?.away ?? '-'}</AppText> {h.teams?.away?.name}</AppText>
              </View>
            ))}
          </Card>
        </Section>
      )}

      <FinalVerdictPanel verdict={a.finalVerdict} homeName={a.homeTeam} awayName={a.awayTeam} />
    </View>
  );
}

/** Análisis completo de béisbol: /api/baseball/match/[id]. */
function BaseballDetail({ id }: { id: string }) {
  const [payload, setPayload] = useState<any>(null);
  const [error, setError] = useState('');
  const tz = getUserTz();
  useEffect(() => {
    let active = true;
    api.get<any>(`/api/baseball/match/${id}`).then((json) => { if (active) setPayload(json); }).catch((cause) => { if (active) setError(cause?.message || 'No fue posible cargar el análisis'); });
    return () => { active = false; };
  }, [id]);
  if (error) return <View style={{ padding: 16 }}><Banner tone="error" message={error} /></View>;
  if (!payload) return <View style={{ padding: 16 }}><SkeletonList count={4} height={140} /></View>;
  const a = payload.analysis;
  const result = payload.result;
  const probs = a?.probabilities;
  const markets: any[] = (Array.isArray(a?.combinada?.selectable) ? a.combinada.selectable : []).filter(bet365Market).sort((l: any, r: any) => Number(r.rawProbability ?? r.probability) - Number(l.rawProbability ?? l.probability) || Number(r.odd) - Number(l.odd));
  const homeName = a?.home_team || 'Local';
  const awayName = a?.away_team || 'Visitante';
  const game = { id: Number(id), teams: { home: { name: homeName }, away: { name: awayName } }, status: { short: result?.status || a?.status }, liveResult: result, analysis: a };
  const state = marketResultState({ sport: 'baseball', game, liveResult: result });
  return (
    <View style={{ padding: 16, gap: 18 }}>
      <Card tone="accent" style={{ gap: 8 }}>
        <AppText variant="kicker" tone="muted">Béisbol · {a?.country} · {a?.league_name}</AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1, alignItems: 'center', gap: 2 }}><AppText variant="label" weight="bold" align="center">{homeName}</AppText><AppText variant="mono" size={26} weight="bold">{result?.home_score ?? '—'}</AppText><AppText variant="caption" tone="accent">Gana {cap((probs?.moneyline?.home?.rawProbability ?? 0) * 100 || probs?.moneyline?.home?.probability || probs?.moneyline?.home)}%</AppText></View>
          <AppText variant="kicker" tone="faint">VS</AppText>
          <View style={{ flex: 1, alignItems: 'center', gap: 2 }}><AppText variant="label" weight="bold" align="center">{awayName}</AppText><AppText variant="mono" size={26} weight="bold">{result?.away_score ?? '—'}</AppText><AppText variant="caption" tone="accent">Gana {cap((probs?.moneyline?.away?.rawProbability ?? 0) * 100 || probs?.moneyline?.away?.probability || probs?.moneyline?.away)}%</AppText></View>
        </View>
        {a?.start_time ? <AppText variant="caption" tone="muted" align="center">{fmtDateTime(a.start_time, tz)}</AppText> : null}
      </Card>
      {result && <Section title={result.status === 'FT' ? 'Resultado oficial MLB' : 'Estadísticas en vivo MLB'}><BaseballResultStats result={result} homeName={homeName} awayName={awayName} /></Section>}
      <Section title="Opciones disponibles en Bet365" hint="Línea exacta de Bet365, probabilidad mínima del 65% y cuota mínima de 1,20.">
        {markets.length ? markets.map((m) => (
          <MarketButton key={m.id} name={m.name || m.pick} probability={Number(m.rawProbability ?? m.probability)} odd={m.odd} bookmaker={m.bookmaker} reliability={m.reliability} validation={m.marketLabel || m.market} outcome={settleMarketSelection({ sport: 'baseball', selection: m, game, liveResult: result })} pendingLabel={state.isLive ? 'En juego' : state.isFinal ? 'Pendiente oficial' : null} />
        )) : <AppText tone="muted">Bet365 no tiene ahora una línea exacta que cumpla ambos criterios. El análisis estadístico completo permanece visible.</AppText>}
      </Section>
      {a?.analysis?.pitcherMatchup && (
        <Section title="Lanzadores abridores">
          <Card style={{ flexDirection: 'row', gap: 16 }}>
            {(['home', 'away'] as const).map((side) => {
              const pitcher = a.analysis.pitcherMatchup[side];
              return (
                <View key={side} style={{ flex: 1, gap: 6 }}>
                  <AppText variant="kicker" tone="muted" numberOfLines={1}>{side === 'home' ? homeName : awayName}</AppText>
                  <AppText variant="label" weight="bold" numberOfLines={1}>{pitcher?.name || 'Por confirmar'}</AppText>
                  {['era', 'whip', 'k9'].map((stat) => pitcher?.stats?.[stat] != null ? (
                    <View key={stat} style={styles.msfSpreadRow}>
                      <AppText variant="caption" tone="secondary">{stat.toUpperCase()}</AppText>
                      <AppText variant="mono" size={12} tone="accent">{msfFmt(pitcher.stats[stat])}</AppText>
                    </View>
                  ) : null)}
                </View>
              );
            })}
          </Card>
        </Section>
      )}
      <Section title="Frecuencias calculadas · análisis completo" hint="Incluye todos los periodos y líneas calculadas, aunque la casa no ofrezca cuota.">
        <MultisportFullFrequencies prediction={probs?.evidence || probs} homeName={homeName} awayName={awayName} scoreLabel="carreras" />
      </Section>
      <FinalVerdictPanel verdict={a?.analysis?.finalVerdict} homeName={homeName} awayName={awayName} />
    </View>
  );
}

/** Baloncesto y fútbol americano: /api/sports/[sport]/match/[id]. */
function MultisportDetail({ sport, id }: { sport: string; id: string }) {
  const [payload, setPayload] = useState<any>(null);
  const [error, setError] = useState('');
  const tz = getUserTz();
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
  const scoreLabel = 'puntos';
  return (
    <View style={{ padding: 16, gap: 18 }}>
      <Card tone="accent" style={{ gap: 8 }}>
        <AppText variant="kicker" tone="muted">{SPORT_LABEL[sport] || sport} · {analysis?.league_name}</AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1, alignItems: 'center', gap: 4 }}><TeamLogo src={match?.home_logo} name={homeName} size={40} /><AppText variant="label" weight="bold" align="center">{homeName}</AppText><AppText variant="mono" size={26} weight="bold">{match?.home_score ?? '—'}</AppText></View>
          <AppText variant="kicker" tone="faint">VS</AppText>
          <View style={{ flex: 1, alignItems: 'center', gap: 4 }}><TeamLogo src={match?.away_logo} name={awayName} size={40} /><AppText variant="label" weight="bold" align="center">{awayName}</AppText><AppText variant="mono" size={26} weight="bold">{match?.away_score ?? '—'}</AppText></View>
        </View>
        {analysis?.start_time ? <AppText variant="caption" tone="muted" align="center">{fmtDateTime(analysis.start_time, tz)}</AppText> : null}
      </Card>
      <Section title="Arma tu combinada · Bet365" hint="Línea exacta de Bet365, probabilidad mínima del 65% y cuota mínima de 1,20.">
        {markets.length ? markets.map((market) => (
          <MarketButton key={market.id} name={market.name || market.pick} probability={Number(market.rawProbability ?? market.probability)} odd={market.odd} bookmaker={market.bookmaker} reliability={market.reliability} validation={displayBettingText(market.marketLabel || market.market || '')} outcome={settleMarketSelection({ sport, selection: market, game, liveResult: match })} pendingLabel={null} />
        )) : <AppText tone="muted">Bet365 no tiene ahora una línea exacta que cumpla ambos criterios. El análisis estadístico completo permanece visible.</AppText>}
      </Section>
      <Section title="Frecuencias calculadas · análisis completo" hint="Incluye todos los periodos y líneas calculadas, aunque la casa no ofrezca cuota. Estas cifras no se convierten por sí solas en recomendaciones.">
        <MultisportFullFrequencies prediction={analysis?.probabilities?.evidence || analysis?.probabilities} homeName={homeName} awayName={awayName} scoreLabel={scoreLabel} />
      </Section>
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
  lastRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: colors.border },
  msfPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 5, paddingHorizontal: 9, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: colors.border },
  msfMeshCell: { minWidth: 84, gap: 2, paddingVertical: 7, paddingHorizontal: 8, borderRadius: radius.sm, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: colors.border },
  msfSpreadRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: colors.border },
});
