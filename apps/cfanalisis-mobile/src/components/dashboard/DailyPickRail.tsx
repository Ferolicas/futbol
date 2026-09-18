import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { AppText } from '@/components/ui';
import { MarketOutcomeBadge } from '@/components/analysis/MarketOutcomeBadge';
import { displayBettingText } from '@/shared/display-betting-text';
import { resolveDailyPickView } from '@/shared/daily-pick-view';
import { assetUrl } from '@/lib/config';
import { cap, oddValue } from '@/lib/format';
import { useAccess } from '@/lib/access-context';
import { colors, radius } from '@/theme/tokens';

export interface DecoratedSelection {
  fixtureId?: string | number;
  id?: string;
  marketKey?: string;
  matchName?: string;
  name?: string;
  market?: string;
  cat?: string;
  bookmaker?: string | null;
  probability?: number;
  rawProbability?: number;
  reliability?: number | null;
  expectedValue?: number | null;
  odd?: number | null;
  resultState: { isLive?: boolean; isFinal?: boolean };
  outcome: { status?: string };
}

interface Props { selections: DecoratedSelection[]; averageProbability?: number; sport: string }

/** Apuesta del día: catálogo ordenado con cuota individual, nunca una cuota conjunta. */
export function DailyPickRail({ selections, averageProbability = 0, sport }: Props) {
  const { isFree } = useAccess();
  const [preferredView, setPreferredView] = useState<'picks' | 'results'>('picks');
  const picks = useMemo(() => selections.filter((item) => !item.resultState.isLive && !item.resultState.isFinal), [selections]);
  const results = useMemo(() => selections.filter((item) => item.resultState?.isFinal || (!isFree && item.resultState?.isLive)), [selections, isFree]);
  const view = resolveDailyPickView(preferredView, picks.length, results.length) as 'picks' | 'results';
  const visible = view === 'results' ? results : picks;
  const visibleProbability = visible.length
    ? visible.reduce((sum, item) => sum + Number(item.rawProbability ?? item.probability ?? 0), 0) / visible.length
    : averageProbability;

  return (
    <View style={styles.rail}>
      <View style={styles.head}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
          <Image source={{ uri: assetUrl('/daily-pick-sticker.webp') || undefined }} style={{ width: 30, height: 28 }} contentFit="contain" />
          <AppText variant="heading" size={15}>Apuesta del día</AppText>
          <Pressable
            onPress={() => {
              if (view === 'results' && picks.length > 0) setPreferredView('picks');
              else if (view === 'picks' && results.length > 0) setPreferredView('results');
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: view === 'results' }}
            style={[styles.resultsBtn, view === 'results' && styles.resultsBtnActive]}
          >
            <AppText variant="caption" weight="bold" style={{ color: view === 'results' ? colors.onAccent : colors.textSecondary }}>Resultados</AppText>
            {results.length > 0 && <AppText variant="mono" size={10.5} style={{ color: view === 'results' ? colors.onAccent : colors.accent }}>{results.length}</AppText>}
          </Pressable>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <AppText variant="caption" tone="secondary">{visible.length} opciones{visible.length > 1 ? ' · desliza →' : ''}</AppText>
          {visible.length > 0 && <AppText variant="caption" tone="accent">{cap(visibleProbability)}% probabilidad</AppText>}
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.track} snapToInterval={196} decelerationRate="fast">
        {visible.length === 0 && (
          <View style={styles.empty}>
            <AppText variant="label" weight="bold">{view === 'results' ? 'Aún no hay resultados' : 'Aún no hay recomendaciones'}</AppText>
            <AppText variant="caption" tone="muted">
              {view === 'results'
                ? (isFree ? 'Aquí aparecerán las recomendaciones cuando los partidos hayan finalizado.' : 'Los partidos en vivo y finalizados aparecerán aquí.')
                : 'Las opciones aparecerán cuando la casa publique líneas que cumplan los criterios.'}
            </AppText>
          </View>
        )}
        {visible.map((sel, index) => {
          const pct = cap(sel.rawProbability ?? sel.probability);
          const probColor = pct >= 85 ? colors.accent : pct >= 80 ? colors.warning : '#d97706';
          let marketName = sel.name || sel.market || 'Pick';
          if (sport === 'football') {
            const suffixes: Record<string, string> = { Goles: 'goles', Córners: 'córners', Tarjetas: 'tarjetas' };
            const suffix = sel.cat ? suffixes[sel.cat] : undefined;
            if (suffix && marketName.toLowerCase().endsWith(suffix)) marketName = `${sel.cat} totales — ${marketName.slice(0, marketName.length - suffix.length).trim()}`;
          }
          const bookmaker = sport === 'football' ? (sel.bookmaker ? `${sel.bookmaker} · ` : '') : 'Bet365 · ';
          const won = sel.outcome?.status === 'won';
          const lost = sel.outcome?.status === 'lost';
          return (
            <View key={`${sel.fixtureId || 'fixture'}-${sel.marketKey || sel.id || index}-${index}`} style={[styles.card, sel.resultState.isLive && styles.cardLive, won && styles.cardWon, lost && styles.cardLost]}>
              <View style={styles.cardTop}>
                <AppText variant="kicker" size={9.5} tone={sel.resultState.isLive ? 'error' : 'muted'}>{sel.resultState.isFinal ? 'Finalizado' : sel.resultState.isLive ? 'En vivo' : 'Próximo'}</AppText>
                <AppText variant="mono" size={11} tone="faint">{String(index + 1).padStart(2, '0')}</AppText>
              </View>
              <AppText variant="caption" tone="muted" numberOfLines={2}>{sel.matchName}</AppText>
              <AppText variant="label" weight="bold" numberOfLines={3}>{bookmaker}{displayBettingText(marketName)}</AppText>
              {view === 'results' && <MarketOutcomeBadge outcome={sel.outcome} pendingLabel={sel.resultState.isLive ? 'En juego' : sel.resultState.isFinal ? 'Pendiente oficial' : null} compact />}
              <View style={styles.metrics}>
                <AppText variant="mono" weight="bold" style={{ color: probColor }}>{pct}%</AppText>
                {sport !== 'football' && Number.isFinite(Number(sel.reliability)) && <AppText variant="caption" tone="cyan">{Math.floor(Number(sel.reliability))}% fiab.</AppText>}
                {sport === 'football' && sel.expectedValue != null && Number.isFinite(Number(sel.expectedValue)) && (
                  <AppText variant="caption" tone="faint">EV {Number(sel.expectedValue) >= 0 ? '+' : ''}{(Number(sel.expectedValue) * 100).toFixed(1)}%</AppText>
                )}
                {oddValue(sel.odd) && <AppText variant="mono" style={{ color: colors.amber, marginLeft: 'auto' }}>@{oddValue(sel.odd)!.toFixed(2)}</AppText>}
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, gap: 8 },
  resultsBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingHorizontal: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.04)' },
  resultsBtnActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  track: { paddingHorizontal: 16, gap: 8 },
  empty: { width: 300, gap: 4, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.03)' },
  card: { width: 188, gap: 5, padding: 12, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSolid },
  cardLive: { borderColor: 'rgba(239,68,68,0.45)' },
  cardWon: { borderColor: colors.accentBorder, backgroundColor: 'rgba(94,230,177,0.06)' },
  cardLost: { borderColor: 'rgba(251,113,133,0.4)', backgroundColor: 'rgba(251,113,133,0.05)' },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  metrics: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
});
