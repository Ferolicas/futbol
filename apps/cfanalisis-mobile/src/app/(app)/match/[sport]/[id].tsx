import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, Zap } from 'lucide-react-native';
import { AppText, Banner, Button, Card, Screen, SkeletonList, TeamLogo } from '@/components/ui';
import { MatchHeadCard } from '@/components/dashboard/MatchHeadCard';
import { toHeadMatch } from '@/components/dashboard/SportGameCard';
import { FinalVerdictPanel } from '@/components/analysis/FinalVerdictPanel';
import { LockedAnalysis } from '@/components/analysis/FreeAccess';
import { MarketButton } from '@/components/analysis/MarketButton';
import { PlayersBlock, ProbBlock, footballMarkets, hasPlayerHighlights } from '@/components/analysis/FootballAnalysisTabs';
import { BaseballResultStats, SportFrequencies } from '@/components/analysis/SportAnalysisTabs';
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
  const lineups = a.lineups?.available ? a.lineups.data : null;

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

      {lineups && (
        <Section title="XI Alineación titular">
          {lineups.map((team: any, index: number) => (
            <Card key={index} style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <TeamLogo src={team.team?.logo} name={team.team?.name} size={24} />
                <AppText variant="label" weight="bold" style={{ flex: 1 }}>{team.team?.name}</AppText>
                <AppText variant="mono" size={12} tone="accent">{team.formation}</AppText>
              </View>
              <AppText variant="caption" tone="muted">DT: {team.coach?.name || 'N/A'}</AppText>
              {(team.startXI || []).map((pl: any, i: number) => (
                <View key={i} style={styles.playerRow}>
                  <AppText variant="mono" size={11} tone="muted" style={{ width: 26 }}>{pl.player?.number}</AppText>
                  <AppText variant="caption" style={{ flex: 1 }} numberOfLines={1}>{pl.player?.name}</AppText>
                  <AppText variant="caption" tone="faint">{pl.player?.pos}</AppText>
                </View>
              ))}
            </Card>
          ))}
        </Section>
      )}

      {p && (
        <Section title="Estadísticas calculadas">
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[['Goles', a.homeTeam, p.homeGoals], ['Goles', a.awayTeam, p.awayGoals]].map(([kind, name, stats]: any) => (
              <Card key={name} style={{ flex: 1, gap: 4 }}>
                <AppText variant="kicker" tone="muted" numberOfLines={1}>{kind} — {name}</AppText>
                <AppText variant="caption" tone="secondary">Anotados <AppText variant="mono" size={12} tone="accent">{stats?.avgScored ?? '—'}</AppText></AppText>
                <AppText variant="caption" tone="secondary">Recibidos <AppText variant="mono" size={12} tone="error">{stats?.avgConceded ?? '—'}</AppText></AppText>
              </Card>
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Card style={{ flex: 1, gap: 4 }}><AppText variant="kicker" tone="muted">Córners</AppText><AppText variant="mono" size={18} tone="cyan">{p.cornerAvg ?? '—'}</AppText><AppText variant="caption" tone="faint">Total combinado</AppText></Card>
            <Card style={{ flex: 1, gap: 4 }}><AppText variant="kicker" tone="muted">Tarjetas</AppText><AppText variant="mono" size={18} tone="warning">{p.cardAvg ?? '—'}</AppText><AppText variant="caption" tone="faint">Amarillas promedio</AppText></Card>
          </View>
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
              {list.map((m: any, i: number) => (
                <View key={i} style={styles.lastRow}>
                  <AppText variant="mono" size={11} weight="bold" style={{ width: 16, color: m.r === 'W' ? colors.accent : m.r === 'L' ? colors.error : colors.warning }}>{m.r || '?'}</AppText>
                  <AppText variant="mono" size={12} style={{ width: 40 }}>{m.gF ?? '?'}-{m.gA ?? '?'}</AppText>
                  <AppText variant="caption" tone="secondary" style={{ flex: 1 }} numberOfLines={1}>vs {m.op || '?'}</AppText>
                  {m.c?.total != null && <AppText variant="caption" tone="cyan">{m.c.total} córners</AppText>}
                  {m.y?.total != null && <AppText variant="caption" tone="warning">{m.y.total} amarillas</AppText>}
                </View>
              ))}
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
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {(['home', 'away'] as const).map((side) => {
              const pitcher = a.analysis.pitcherMatchup[side];
              return (
                <Card key={side} style={{ flex: 1, gap: 3 }}>
                  <AppText variant="kicker" tone="muted" numberOfLines={1}>{side === 'home' ? homeName : awayName}</AppText>
                  <AppText variant="label" weight="bold">{pitcher?.name || 'Por confirmar'}</AppText>
                  {['era', 'whip', 'k9'].map((stat) => pitcher?.stats?.[stat] != null ? <AppText key={stat} variant="caption" tone="secondary">{stat.toUpperCase()} <AppText variant="mono" size={12}>{pitcher.stats[stat]}</AppText></AppText> : null)}
                </Card>
              );
            })}
          </View>
        </Section>
      )}
      <Section title="Frecuencias calculadas · análisis completo" hint="Incluye todos los periodos y líneas calculadas, aunque la casa no ofrezca cuota.">
        <SportFrequencies probabilities={probs} home={homeName} away={awayName} scoreLabel="carreras" />
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
        <SportFrequencies probabilities={analysis?.probabilities} home={homeName} away={awayName} scoreLabel={scoreLabel} />
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
});
