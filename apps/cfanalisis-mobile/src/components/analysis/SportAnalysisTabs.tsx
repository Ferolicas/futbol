import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { ArrowRight, ChartColumn, Flag, Layers, Scale } from 'lucide-react-native';
import { AppText, Button, Card } from '@/components/ui';
import { HorizontalChoiceBar } from './HorizontalChoiceBar';
import { MarketButton } from './MarketButton';
import { FinalVerdictPanel } from './FinalVerdictPanel';
import { FreeRecommendations, LockedAnalysis } from './FreeAccess';
import { marketResultState, settleMarketSelection } from '@/shared/market-settlement';
import { cap } from '@/lib/format';
import { colors } from '@/theme/tokens';

const percent = (entry: any): number | null => {
  if (entry == null) return null;
  const value = typeof entry === 'object' ? (entry.rawProbability != null ? Number(entry.rawProbability) * 100 : Number(entry.probability)) : Number(entry);
  return Number.isFinite(value) ? Math.min(95, Math.floor(value * 100) / 100) : null;
};
const probabilityText = (value: number | null) => value == null ? '—' : `${value}%`;
const PERIOD_LABELS: Record<string, string> = { firstHalf: 'Primera mitad', secondHalf: 'Segunda mitad', quarter1: 'Primer cuarto', quarter2: 'Segundo cuarto', quarter3: 'Tercer cuarto', quarter4: 'Cuarto cuarto', first3: 'Primeras 3 entradas', first4_5: 'Primeras 4,5 entradas', first5: 'Primeras 5 entradas', first7: 'Primeras 7 entradas' };

const valueOrDash = (value: unknown) => value == null || !Number.isFinite(Number(value)) ? '—' : String(Number(value));

/** Boxscore MLB (hits, jonrones, errores…) y carreras por entrada. */
export function BaseballResultStats({ result, homeName = 'Local', awayName = 'Visitante', compact = false }: { result: any; homeName?: string; awayName?: string; compact?: boolean }) {
  if (!result) return null;
  const homeStats = result.home_stats || {};
  const awayStats = result.away_stats || {};
  const metrics = [
    { key: 'hits', short: 'H', home: result.home_hits ?? homeStats.hits, away: result.away_hits ?? awayStats.hits },
    { key: 'homeRuns', short: 'HR', home: homeStats.homeRuns, away: awayStats.homeRuns },
    { key: 'errors', short: 'E', home: result.home_errors ?? homeStats.errors, away: result.away_errors ?? awayStats.errors },
    { key: 'walks', short: 'BB', home: homeStats.walks, away: awayStats.walks },
    { key: 'strikeouts', short: 'K', home: homeStats.strikeouts, away: awayStats.strikeouts },
    { key: 'leftOnBase', short: 'LOB', home: homeStats.leftOnBase, away: awayStats.leftOnBase },
    ...(!compact ? [
      { key: 'doubles', short: '2B', home: homeStats.doubles, away: awayStats.doubles },
      { key: 'triples', short: '3B', home: homeStats.triples, away: awayStats.triples },
      { key: 'totalBases', short: 'TB', home: homeStats.totalBases, away: awayStats.totalBases },
      { key: 'rbis', short: 'RBI', home: homeStats.rbis, away: awayStats.rbis },
      { key: 'atBats', short: 'AB', home: homeStats.atBats, away: awayStats.atBats },
      { key: 'stolenBases', short: 'BR', home: homeStats.stolenBases, away: awayStats.stolenBases },
    ] : []),
  ].filter((metric) => metric.home != null || metric.away != null);
  const innings: any[] = Array.isArray(result.innings) ? result.innings : [];
  if (!metrics.length && (!innings.length || compact)) return null;
  const teamLabel = (name: string, fallback: string) => {
    const parts = String(name || fallback).trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return (parts[0] || fallback).slice(0, 3).toUpperCase();
    return parts.map((part) => part[0]).join('').slice(0, 3).toUpperCase();
  };
  const cell = (value: React.ReactNode, key: string, head = false) => (
    <View key={key} style={{ width: 40, alignItems: 'center' }}>
      <AppText variant="mono" size={11} tone={head ? 'faint' : 'default'}>{value}</AppText>
    </View>
  );
  return (
    <Card padded={false} style={{ padding: 10 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ gap: 4 }}>
          {metrics.length > 0 && (
            <>
              <View style={styles.tableRow}><View style={{ width: 54 }} />{metrics.map((m) => cell(m.short, m.key, true))}</View>
              {[{ key: 'home', name: homeName, fallback: 'LOC', values: metrics.map((m) => m.home), color: '#67e8f9' }, { key: 'away', name: awayName, fallback: 'VIS', values: metrics.map((m) => m.away), color: '#fcd34d' }].map((team) => (
                <View key={team.key} style={styles.tableRow}>
                  <View style={{ width: 54 }}><AppText variant="mono" size={11} weight="bold" style={{ color: team.color }}>{teamLabel(team.name, team.fallback)}</AppText></View>
                  {team.values.map((value, index) => cell(valueOrDash(value), `${team.key}-${metrics[index].key}`))}
                </View>
              ))}
            </>
          )}
          {!compact && innings.length > 0 && (
            <View style={{ marginTop: 8, gap: 2 }}>
              <AppText variant="kicker" size={9.5} tone="muted">Carreras por entrada</AppText>
              {[{ key: 'head', label: '', values: innings.map((i) => i.number ?? i.num) }, { key: 'home', label: teamLabel(homeName, 'LOC'), values: innings.map((i) => i.home) }, { key: 'away', label: teamLabel(awayName, 'VIS'), values: innings.map((i) => i.away) }].map((row) => (
                <View key={row.key} style={styles.tableRow}>
                  <View style={{ width: 54 }}><AppText variant="mono" size={11} tone="muted">{row.label}</AppText></View>
                  {row.values.map((value: unknown, index: number) => cell(valueOrDash(value), `${row.key}-${index}`, row.key === 'head'))}
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </Card>
  );
}

function DiamondBase({ occupied, style }: { occupied: boolean; style: any }) {
  return <View style={[styles.base, style, occupied ? styles.baseOn : styles.baseOff]} />;
}

/** Diamante con corredores en base + conteo (bolas-strikes) + outs + entrada.
 * Mismo estado pitch-by-pitch que la web (bases/balls/strikes/outs/inning). */
export function LiveDiamond({ live }: { live: any }) {
  if (!live) return null;
  const b = live.bases || {};
  const hasCount = live.balls != null || live.strikes != null || live.outs != null;
  if (!hasCount && !b.first && !b.second && !b.third) return null;
  const balls = live.balls ?? 0;
  const strikes = live.strikes ?? 0;
  const outs = live.outs ?? 0;
  const arrow = live.inning_half === 'top' ? '↑' : live.inning_half === 'bottom' ? '↓' : '';
  return (
    <Card tone="accent" style={styles.diamondCard}>
      <View style={styles.diamond}>
        <DiamondBase occupied={!!b.second} style={{ top: '10%', left: '38%' }} />
        <DiamondBase occupied={!!b.third} style={{ top: '38%', left: '10%' }} />
        <DiamondBase occupied={!!b.first} style={{ top: '38%', left: '66%' }} />
      </View>
      <View style={{ gap: 3 }}>
        <AppText variant="mono" size={12} weight="bold" tone="accent">{arrow}{live.inning ?? ''} · {balls}-{strikes}</AppText>
        <AppText variant="mono" size={11} tone="secondary">{'●'.repeat(Math.min(outs, 3))}{'○'.repeat(Math.max(0, 2 - outs))} outs</AppText>
      </View>
      {(live.currentPitcher?.name || live.currentBatter?.name) && (
        <View style={{ gap: 2, flex: 1, minWidth: 0 }}>
          {live.currentPitcher?.name && <AppText variant="caption" tone="muted" numberOfLines={1}>⚾ {live.currentPitcher.name}</AppText>}
          {live.currentBatter?.name && <AppText variant="caption" tone="muted" numberOfLines={1}>🏏 {live.currentBatter.name}</AppText>}
        </View>
      )}
    </Card>
  );
}

const QUARTER_LABELS = ['C1', 'C2', 'C3', 'C4'];

/** Marcador por cuarto (NBA/NCAA) — mismo patrón que BaseballResultStats,
 * con game.periods.home/away que ya captura nba-stats-api.js/espn-sports-api.js. */
export function BasketballResultStats({ periods, homeName = 'Local', awayName = 'Visitante' }: { periods: any; homeName?: string; awayName?: string }) {
  const home: any[] = Array.isArray(periods?.home) ? periods.home : [];
  const away: any[] = Array.isArray(periods?.away) ? periods.away : [];
  const count = Math.max(home.length, away.length);
  if (!count) return null;
  const teamLabel = (name: string, fallback: string) => {
    const parts = String(name || fallback).trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return (parts[0] || fallback).slice(0, 3).toUpperCase();
    return parts.map((part) => part[0]).join('').slice(0, 3).toUpperCase();
  };
  const periodLabel = (index: number) => QUARTER_LABELS[index] || `OT${index - 3}`;
  const total = (values: any[]) => values.reduce((sum, value) => sum + (Number(value) || 0), 0);
  const cell = (value: React.ReactNode, key: string, head = false) => (
    <View key={key} style={{ width: 34, alignItems: 'center' }}>
      <AppText variant="mono" size={11} tone={head ? 'faint' : 'default'}>{value}</AppText>
    </View>
  );
  return (
    <Card padded={false} style={{ padding: 10 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ gap: 4 }}>
          <View style={styles.tableRow}>
            <View style={{ width: 54 }} />
            {Array.from({ length: count }, (_, i) => cell(periodLabel(i), `h${i}`, true))}
            {cell('TOT', 'htot', true)}
          </View>
          {[
            { key: 'home', name: homeName, fallback: 'LOC', values: home, color: '#67e8f9' },
            { key: 'away', name: awayName, fallback: 'VIS', values: away, color: '#fcd34d' },
          ].map((team) => (
            <View key={team.key} style={styles.tableRow}>
              <View style={{ width: 54 }}><AppText variant="mono" size={11} weight="bold" style={{ color: team.color }}>{teamLabel(team.name, team.fallback)}</AppText></View>
              {Array.from({ length: count }, (_, i) => cell(valueOrDash(team.values[i]), `${team.key}-${i}`))}
              {cell(total(team.values), `${team.key}-tot`)}
            </View>
          ))}
        </View>
      </ScrollView>
    </Card>
  );
}

/** Frecuencias calculadas para béisbol, baloncesto y fútbol americano. */
export function SportFrequencies({ probabilities, home, away, scoreLabel = 'puntos' }: { probabilities: any; home: string; away: string; scoreLabel?: string }) {
  const [active, setActive] = useState('score');
  const p = probabilities?.evidence || probabilities;
  if (!p) return <AppText tone="muted">Las frecuencias aparecerán cuando termine el análisis.</AppText>;
  const groups = [
    { key: 'score', label: scoreLabel === 'carreras' ? 'Carreras' : 'Puntos', color: '#4ade80' },
    ...Object.entries<any>(p.statistics || {}).map(([key, value]) => ({ key, label: value.label || key, color: '#fbbf24' })),
    ...Object.entries<any>(p.periods || {}).map(([key, value]) => ({ key: `period-${key}`, label: value.label || PERIOD_LABELS[key] || key, color: '#22d3ee' })),
  ];
  const resolved = groups.some((group) => group.key === active) ? active : 'score';
  const selected = resolved.startsWith('period-') ? p.periods[resolved.slice(7)] : resolved === 'score' ? p : p.statistics[resolved];
  const isScore = resolved === 'score' || resolved.startsWith('period-');
  const label = isScore ? scoreLabel : selected.label || resolved;
  const ladders: Array<[string, any]> = isScore
    ? [['Total del partido', selected.displayFrequencies?.totals || selected.totals?.lines || selected.totals], [home, selected.displayFrequencies?.home || selected.teamTotals?.home], [away, selected.displayFrequencies?.away || selected.teamTotals?.away]]
    : [['Total del partido', selected.total], [home, selected.home], [away, selected.away]];
  return (
    <View style={{ gap: 10 }}>
      <HorizontalChoiceBar small items={groups} active={resolved} onChange={setActive} />
      <AppText variant="caption" tone="muted">Cada porcentaje cuenta antecedentes comparables que superaron o quedaron por debajo de la línea. Los empates con una línea entera se contabilizan aparte.</AppText>
      {ladders.map(([title, lines]) => {
        const entries = Object.entries<any>(lines || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
        if (!entries.length) return null;
        return (
          <Card key={title} style={{ gap: 4 }}>
            <AppText variant="kicker" tone="secondary">{title} · {label}</AppText>
            {entries.map(([line, values]) => (
              <View key={line} style={styles.pair}>
                {(['over', 'under'] as const).map((side) => (
                  <View key={side} style={styles.pairRow}>
                    <AppText variant="caption" tone="secondary">{side === 'over' ? 'Más' : 'Menos'} de {line}</AppText>
                    <AppText variant="mono" size={13}>{probabilityText(percent(values?.[side]))}</AppText>
                  </View>
                ))}
              </View>
            ))}
          </Card>
        );
      })}
      {isScore && selected.moneyline && (
        <Card style={{ gap: 4 }}>
          <AppText variant="kicker" tone="secondary">Resultado</AppText>
          {[['home', home], ['draw', 'Empate'], ['away', away]].filter(([side]) => selected.moneyline[side] != null).map(([side, name]) => (
            <View key={side} style={styles.pairRow}>
              <AppText variant="caption" tone="secondary">{name}</AppText>
              <AppText variant="mono" size={13}>{probabilityText(percent(selected.moneyline[side]))}</AppText>
            </View>
          ))}
        </Card>
      )}
    </View>
  );
}

interface TabsProps {
  game: any;
  sport: string;
  scoreLabel: string;
  selected: Record<string, unknown>;
  onToggle: (pick: any) => void;
  onViewFull?: (() => void) | null;
}

/** Pestañas compartidas por béisbol, baloncesto y fútbol americano. */
export function SportAnalysisTabs({ game, sport, scoreLabel, selected, onToggle, onViewFull }: TabsProps) {
  const [active, setActive] = useState('markets');
  const analysis = game.analysis;
  const free = analysis?.access === 'free';
  const picks: any[] = analysis?.combinada?.selectable || analysis?.combinada?.selections || [];
  const tabs = useMemo(() => [
    { key: 'markets', label: 'Mercados para tu combinada', color: '#5ee6b1', icon: <Layers size={14} color={active === 'markets' ? '#5ee6b1' : colors.muted} /> },
    { key: 'stats', label: 'Estadísticas calculadas', color: '#f97316', icon: <Scale size={14} color={active === 'stats' ? '#f97316' : colors.muted} /> },
    { key: 'probs', label: 'Frecuencias calculadas', color: '#2dd4bf', icon: <ChartColumn size={14} color={active === 'probs' ? '#2dd4bf' : colors.muted} /> },
    { key: 'verdict', label: 'Veredicto final', color: '#f5e400', icon: <Flag size={14} color={active === 'verdict' ? '#f5e400' : colors.muted} /> },
    ...(free ? [{ key: 'full', label: 'Análisis completo', color: '#bce1ab' }] : []),
  ], [free, active]);
  useEffect(() => { if (!tabs.some((tab) => tab.key === active)) setActive('markets'); }, [tabs, active]);
  const prediction = analysis?.probabilities?.evidence || analysis?.probabilities;
  const state = marketResultState({ sport, game, liveResult: game.liveResult });
  const pendingLabel = state.isLive ? 'En juego' : state.isFinal ? 'Pendiente oficial' : null;
  const homeName = game.teams?.home?.name || 'Local';
  const awayName = game.teams?.away?.name || 'Visitante';

  return (
    <View style={{ gap: 12 }}>
      <HorizontalChoiceBar items={tabs} active={active} onChange={setActive} />
      {free ? (
        active === 'markets'
          ? <FreeRecommendations preview={analysis.freePreview} selected={selected} onToggle={onToggle} />
          : <LockedAnalysis title={tabs.find((tab) => tab.key === active)?.label} />
      ) : active === 'markets' ? (
        <View style={{ gap: 8 }}>
          {picks.map((pick) => (
            <MarketButton
              key={pick.id}
              name={pick.name || pick.pick}
              probability={Number(pick.rawProbability ?? pick.probability)}
              odd={pick.odd}
              bookmaker={pick.bookmaker}
              reliability={pick.reliability}
              validation="Recomendación estadística"
              selected={!!selected[pick.id]}
              onPress={() => onToggle(pick)}
              outcome={settleMarketSelection({ sport, selection: pick, game, liveResult: game.liveResult })}
              pendingLabel={pendingLabel}
            />
          ))}
          {!picks.length && <AppText tone="muted">Todavía no hay opciones que cumplan los criterios de recomendación.</AppText>}
        </View>
      ) : active === 'probs' ? (
        <SportFrequencies probabilities={analysis?.probabilities} home={homeName} away={awayName} scoreLabel={scoreLabel} />
      ) : active === 'verdict' ? (
        <FinalVerdictPanel verdict={analysis?.analysis?.finalVerdict} homeName={homeName} awayName={awayName} compact embedded />
      ) : (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[['Local', prediction?.expected?.home], ['Total', prediction?.expected?.total], ['Visitante', prediction?.expected?.away]].map(([name, value]) => (
              <Card key={String(name)} style={{ flex: 1, alignItems: 'center', gap: 2 }}>
                <AppText variant="caption" tone="muted">{name} · {scoreLabel}</AppText>
                <AppText variant="mono" weight="bold" size={18}>{value == null ? '—' : Number(value).toFixed(2)}</AppText>
                <AppText variant="caption" tone="faint">Media calculada</AppText>
              </Card>
            ))}
          </View>
          {sport === 'baseball' && (
            <>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {(['home', 'away'] as const).map((side) => {
                  const pitcher = analysis?.analysis?.pitcherMatchup?.[side];
                  return (
                    <Card key={side} style={{ flex: 1, gap: 4 }}>
                      <AppText variant="kicker" tone="muted" numberOfLines={1}>{game.teams[side].name}</AppText>
                      <AppText variant="label" weight="bold" numberOfLines={2}>{pitcher?.name || game.probablePitchers?.[side] || 'Abridor por confirmar'}</AppText>
                      <AppText variant="caption" tone="secondary">ERA <AppText variant="mono" size={12}>{pitcher?.stats?.era ?? '—'}</AppText></AppText>
                      <AppText variant="caption" tone="secondary">Gana <AppText variant="mono" size={12} tone="accent">{probabilityText(percent(analysis?.combinada?.winProbabilities?.[side]))}</AppText></AppText>
                    </Card>
                  );
                })}
              </View>
              <BaseballResultStats result={game.liveResult} homeName={homeName} awayName={awayName} compact />
            </>
          )}
        </View>
      )}
      {onViewFull && <Button title="Ver análisis completo" variant="secondary" size="lg" onPress={onViewFull} icon={<ArrowRight size={16} color={colors.accent} />} />}
    </View>
  );
}

const styles = StyleSheet.create({
  tableRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2 },
  pair: { borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: 3 },
  pairRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 2 },
  diamondCard: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 10 },
  diamond: { width: 40, height: 40, flexShrink: 0 },
  base: { position: 'absolute', width: 12, height: 12, transform: [{ rotate: '45deg' }] },
  baseOn: { backgroundColor: colors.accent, borderWidth: 1, borderColor: colors.accent },
  baseOff: { backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
});
