import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ArrowRight, ChartColumn, Flag, Layers, Scale, Sparkles } from 'lucide-react-native';
import { AppText, Button, Card } from '@/components/ui';
import { HorizontalChoiceBar } from './HorizontalChoiceBar';
import { MarketButton } from './MarketButton';
import { FinalVerdictPanel } from './FinalVerdictPanel';
import { FreeRecommendations, LockedAnalysis } from './FreeAccess';
import { marketLabel } from '@/shared/market-labels';
import { meetsFootballReliability } from '@/shared/recommendation-policy';
import { marketResultState, settleMarketSelection } from '@/shared/market-settlement';
import { buildFootballProbabilityGroups } from '@/shared/probability-lines';
import { cap } from '@/lib/format';
import { colors, radius } from '@/theme/tokens';

/** Catálogo "Mercados para tu combinada": líneas del motor con fiabilidad ≥90%, cuota ≥1.20 y probabilidad ≥70%. */
export function footballMarkets(data: any, match: any) {
  const isEngine = data?.combinada?.source === 'context-engine';
  const sels: any[] = isEngine ? (data.combinada.selectable || data.combinada.selections || []) : [];
  return sels
    .filter((s) => meetsFootballReliability(s.confidence) && s.odd && s.odd >= 1.2 && Number(s.rawProbability ?? s.probability) >= 70)
    .map((s, index) => ({
      ...s,
      id: s.id || `mkt-${index}`,
      name: s.scope === 'context' ? marketLabel(s.id, { home: match.teams.home.name, away: match.teams.away.name }) : s.name,
      bookmaker: s.bookmaker || null,
      recommended: s.recommended === true,
      cat: s.scope === 'player' ? 'Player'
        : s.category?.includes('corners') ? 'Corners'
          : s.category?.includes('cards') ? 'Tarjetas'
            : s.category?.includes('goals') || s.category === 'winner' || s.category === 'btts' ? 'Goles'
              : s.category || 'Otros',
    }))
    .sort((a, b) => Number(b.rawProbability ?? b.probability) - Number(a.rawProbability ?? a.probability));
}

function StatCell({ label, value, color }: { label: string; value: unknown; color?: string }) {
  const text = value == null || Number.isNaN(value as number) ? '—' : (typeof value === 'number' ? value.toFixed(2) : String(value));
  return (
    <View style={styles.statRow}>
      <AppText variant="caption" tone="secondary">{label}</AppText>
      <AppText variant="mono" size={13} style={{ color: color || colors.text }}>{text}</AppText>
    </View>
  );
}

function StatsBlock({ p, homeTeam, awayTeam }: { p: any; homeTeam: string; awayTeam: string }) {
  const [group, setGroup] = useState('goals');
  const ccd = p?.cornerCardData || {};
  return (
    <View style={{ gap: 10 }}>
      <HorizontalChoiceBar small items={[{ key: 'goals', label: 'Goles', color: '#4ade80' }, { key: 'corners', label: 'Córners', color: '#22d3ee' }, { key: 'cards', label: 'Tarjetas', color: '#fbbf24' }]} active={group} onChange={setGroup} />
      {group === 'goals' && (
        <>
          <Card><AppText variant="kicker" tone="muted" style={{ marginBottom: 6 }}>Goles — {homeTeam}</AppText>
            <StatCell label="Prom. anotados" value={p.homeGoals?.avgScored} color="#4ade80" />
            <StatCell label="Prom. recibidos" value={p.homeGoals?.avgConceded} color="#f87171" />
            <StatCell label="Prom. vs rival H2H" value={p.h2hGoals?.homeAvg} color="#67e8f9" />
          </Card>
          <Card><AppText variant="kicker" tone="muted" style={{ marginBottom: 6 }}>Goles — {awayTeam}</AppText>
            <StatCell label="Prom. anotados" value={p.awayGoals?.avgScored} color="#4ade80" />
            <StatCell label="Prom. recibidos" value={p.awayGoals?.avgConceded} color="#f87171" />
            <StatCell label="Prom. vs rival H2H" value={p.h2hGoals?.awayAvg} color="#f472b6" />
          </Card>
        </>
      )}
      {group === 'corners' && (
        <Card><AppText variant="kicker" tone="muted" style={{ marginBottom: 6 }}>Córners (últimos 5)</AppText>
          <StatCell label={`${homeTeam} a favor`} value={ccd.homeCornersAvg} />
          <StatCell label={`${homeTeam} en contra`} value={ccd.homeCornersAgainstAvg} />
          <StatCell label={`${awayTeam} a favor`} value={ccd.awayCornersAvg} />
          <StatCell label={`${awayTeam} en contra`} value={ccd.awayCornersAgainstAvg} />
          <StatCell label="Total combinado" value={p.cornerAvg} color="#4ade80" />
        </Card>
      )}
      {group === 'cards' && (
        <Card><AppText variant="kicker" tone="muted" style={{ marginBottom: 6 }}>Tarjetas (últimos 5)</AppText>
          <StatCell label={`${homeTeam} amarillas`} value={ccd.homeYellowsAvg} />
          <StatCell label={`${homeTeam} rojas`} value={ccd.homeRedsAvg} />
          <StatCell label={`${awayTeam} amarillas`} value={ccd.awayYellowsAvg} />
          <StatCell label={`${awayTeam} rojas`} value={ccd.awayRedsAvg} />
          <StatCell label="Total amarillas prom." value={p.cardAvg} color="#fbbf24" />
        </Card>
      )}
    </View>
  );
}

export function ProbBlock({ p, odds, homeTeam, awayTeam }: { p: any; odds: any; homeTeam: string; awayTeam: string }) {
  const [group, setGroup] = useState('goles');
  const groups = useMemo(() => {
    if (!p) return [];
    const all = buildFootballProbabilityGroups(p, odds, homeTeam, awayTeam);
    return [
      { key: 'goles', label: 'Goles', color: '#4ade80' },
      { key: 'corners', label: 'Córners', color: '#fbbf24' },
      { key: 'tarjetas', label: 'Tarjetas', color: '#f59e0b' },
      { key: 'tiros', label: 'Tiros', color: '#3b82f6' },
      { key: 'faltas', label: 'Faltas', color: '#fb923c' },
      { key: 'offsides', label: 'Fueras de juego', color: '#a78bfa' },
    ].map((g) => ({ ...g, cats: all.filter((c: any) => c.group === g.key) })).filter((g) => g.cats.length > 0);
  }, [p, odds, homeTeam, awayTeam]);
  if (!p || !groups.length) return <AppText tone="muted">Las frecuencias aparecerán cuando termine el análisis.</AppText>;
  const selected = groups.find((g) => g.key === group) || groups[0];
  return (
    <View style={{ gap: 10 }}>
      <HorizontalChoiceBar small items={groups.map((g) => ({ key: g.key, label: g.label, color: g.color, count: g.cats.length }))} active={selected.key} onChange={setGroup} />
      <AppText variant="caption" tone="muted">La media resume cuántos eventos hubo por partido; cada porcentaje cuenta en cuántos antecedentes se superó esa línea. Son medidas distintas.</AppText>
      {selected.cats.map((cat: any, index: number) => (
        <Card key={index} style={{ gap: 2 }}>
          <AppText variant="kicker" tone="secondary" numberOfLines={1}>{cat.title}</AppText>
          {cat.subtitle ? <AppText variant="caption" tone="muted">{cat.subtitle}</AppText> : null}
          {cat.items.map((it: any, i: number) => {
            const v = cap(it.value);
            const color = v >= 80 ? '#4ade80' : v >= 65 ? '#fbbf24' : v >= 50 ? '#f97316' : '#94a3b8';
            return (
              <View key={i} style={styles.probRow}>
                <AppText variant="caption" tone="secondary" style={{ flex: 1 }} numberOfLines={1}>{it.label}</AppText>
                <AppText variant="caption" tone={it.odd ? 'cyan' : 'faint'}>{it.odd ? `Cuota ${it.odd.toFixed(2)}` : 'Cuota pendiente'}</AppText>
                <AppText variant="mono" size={13} weight="bold" style={{ color, minWidth: 54, textAlign: 'right' }}>{v}%</AppText>
              </View>
            );
          })}
        </Card>
      ))}
    </View>
  );
}

const PLAYER_GROUPS = [
  { key: 'scorers', label: 'Goleadores', hint: 'Gol en 5+ de los últimos 10', color: '#22c55e', metric: 'goals', total: 'totalGoals', unit: 'goles' },
  { key: 'shooters', label: 'A puerta', hint: 'Remate al arco en 5+ de los últimos 10', color: '#3b82f6', metric: 'shotsOnGoal', total: 'totalShotsOn', unit: 'a puerta' },
  { key: 'shotsTotalists', label: 'Tiros totales', hint: '2+ tiros en 5+ de los últimos 10', color: '#60a5fa', metric: 'shotsTotal', total: 'totalShotsAll', unit: 'tiros totales' },
  { key: 'assisters', label: 'Asistentes', hint: 'Asistencia en 5+ de los últimos 10', color: '#a78bfa', metric: 'assists', total: 'totalAssists', unit: 'asistencias' },
  { key: 'foulers', label: 'Faltas', hint: 'Falta en 5+ de los últimos 10', color: '#f59e0b', metric: 'fouls', total: 'totalFouls', unit: 'faltas' },
  { key: 'bookers', label: 'Tarjetas', hint: 'Amarilla en 5+ de los últimos 10', color: '#facc15', metric: 'yellows', total: 'totalYellows', unit: 'amarillas' },
];

export function hasPlayerHighlights(highlights: any) {
  return PLAYER_GROUPS.some((g) => Array.isArray(highlights?.[g.key]) && highlights[g.key].length > 0);
}

export function PlayersBlock({ highlights }: { highlights: any }) {
  const groups = useMemo(() => PLAYER_GROUPS.map((g) => ({ ...g, data: highlights?.[g.key] })).filter((g) => Array.isArray(g.data) && g.data.length > 0), [highlights]);
  const [active, setActive] = useState('scorers');
  if (!groups.length) return null;
  const selected = groups.find((g) => g.key === active) || groups[0];
  return (
    <View style={{ gap: 10 }}>
      <HorizontalChoiceBar small items={groups.map((g) => ({ key: g.key, label: g.label, color: g.color }))} active={selected.key} onChange={setActive} />
      <AppText variant="caption" tone="muted">{selected.hint}</AppText>
      {selected.data.slice(0, 5).map((pl: any, index: number) => {
        const hist: number[] = pl[selected.metric] || [];
        return (
          <Card key={index} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <AppText variant="label" weight="bold" numberOfLines={1}>{pl.name}</AppText>
                <AppText variant="caption" tone="muted">{pl.teamName}</AppText>
              </View>
              <AppText variant="mono" size={12} style={{ color: selected.color }}>{pl[selected.total]} {selected.unit}</AppText>
            </View>
            <View style={{ flexDirection: 'row', gap: 4 }}>
              {hist.slice(0, 10).map((n, j) => (
                <View key={j} style={[styles.dot, { backgroundColor: n > 0 ? selected.color : 'rgba(255,255,255,0.06)' }]}>
                  <AppText variant="mono" size={10} style={{ color: n > 0 ? '#0f172a' : colors.faint }}>{n > 0 ? n : '—'}</AppText>
                </View>
              ))}
            </View>
          </Card>
        );
      })}
    </View>
  );
}

interface TabsProps {
  match: any;
  data: any;
  liveStats: any;
  selected: Record<string, unknown>;
  onToggleMarket: (market: any) => void;
  onViewFull?: (() => void) | null;
}

/** Cuerpo del partido desplegado de fútbol: Mercados, Estadísticas, Frecuencias, Jugadores y Veredicto. */
export function FootballAnalysisTabs({ match, data, liveStats, selected, onToggleMarket, onViewFull }: TabsProps) {
  const [active, setActive] = useState('markets');
  const markets = useMemo(() => footballMarkets(data, match), [data, match]);
  const free = data?.access === 'free';
  const tabs = useMemo(() => [
    (free || markets.length > 0) && { key: 'markets', label: 'Mercados para tu combinada', count: free ? (data.freePreview?.selection ? 1 : 0) : markets.length, color: '#5ee6b1', icon: <Layers size={14} color={active === 'markets' ? '#5ee6b1' : colors.muted} /> },
    (free || data?.calculatedProbabilities) && { key: 'stats', label: 'Estadísticas calculadas', color: '#f97316', icon: <Scale size={14} color={active === 'stats' ? '#f97316' : colors.muted} /> },
    (free || data?.calculatedProbabilities) && { key: 'probs', label: 'Frecuencias calculadas', color: '#2dd4bf', icon: <ChartColumn size={14} color={active === 'probs' ? '#2dd4bf' : colors.muted} /> },
    hasPlayerHighlights(data?.playerHighlights) && { key: 'players', label: 'Jugadores destacados', color: '#fbbf24', icon: <Sparkles size={14} color={active === 'players' ? '#fbbf24' : colors.muted} /> },
    { key: 'verdict', label: 'Veredicto final', color: '#f5e400', icon: <Flag size={14} color={active === 'verdict' ? '#f5e400' : colors.muted} /> },
    free && { key: 'full', label: 'Análisis completo', color: '#bce1ab' },
  ].filter(Boolean) as Array<{ key: string; label: string; color: string; count?: number; icon?: React.ReactNode }>, [free, markets.length, data, active]);
  const resolved = tabs.some((tab) => tab.key === active) ? active : tabs[0]?.key;
  useEffect(() => { if (resolved && resolved !== active) setActive(resolved); }, [resolved, active]);
  if (!data) return <AppText tone="muted">Sin datos de análisis.</AppText>;
  const resultState = marketResultState({ sport: 'football', game: match, liveResult: liveStats });
  const pendingLabel = resultState.isLive ? 'En juego' : resultState.isFinal ? 'Pendiente oficial' : null;
  const matchName = `${match.teams.home.name} vs ${match.teams.away.name}`;

  return (
    <View style={{ gap: 12 }}>
      <HorizontalChoiceBar items={tabs} active={resolved} onChange={setActive} />
      {free ? (
        resolved === 'markets'
          ? <FreeRecommendations preview={data.freePreview} selected={selected} onToggle={(pick) => onToggleMarket({ ...pick, matchName })} />
          : <LockedAnalysis title={tabs.find((tab) => tab.key === resolved)?.label} />
      ) : (
        <>
          {resolved === 'markets' && (
            <View style={{ gap: 8 }}>
              {markets.map((mkt) => (
                <MarketButton
                  key={mkt.id}
                  name={mkt.name}
                  probability={Number(mkt.rawProbability ?? mkt.probability)}
                  odd={mkt.odd}
                  bookmaker={mkt.bookmaker}
                  expectedValue={mkt.expectedValue}
                  validation={mkt.recommended ? 'Recomendación estadística' : 'Dato estadístico'}
                  selected={!!selected[mkt.id]}
                  onPress={() => onToggleMarket({ ...mkt, matchName })}
                  outcome={settleMarketSelection({ sport: 'football', selection: mkt, game: match, liveResult: liveStats })}
                  pendingLabel={pendingLabel}
                />
              ))}
              {!markets.length && <AppText tone="muted">Todavía no hay opciones que cumplan los criterios de recomendación.</AppText>}
            </View>
          )}
          {resolved === 'stats' && data.calculatedProbabilities && <StatsBlock p={data.calculatedProbabilities} homeTeam={match.teams.home.name} awayTeam={match.teams.away.name} />}
          {resolved === 'probs' && <ProbBlock p={data.calculatedProbabilities} odds={data.odds} homeTeam={match.teams.home.name} awayTeam={match.teams.away.name} />}
          {resolved === 'players' && <PlayersBlock highlights={data.playerHighlights} />}
          {resolved === 'verdict' && <FinalVerdictPanel verdict={data.finalVerdict} homeName={match.teams.home.name} awayName={match.teams.away.name} compact embedded />}
        </>
      )}
      {onViewFull && (
        <Button title="Ver análisis completo" variant="secondary" size="lg" onPress={onViewFull} icon={<ArrowRight size={16} color={colors.accent} />} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  statRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: colors.border },
  probRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: colors.border },
  dot: { width: 24, height: 22, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
});
