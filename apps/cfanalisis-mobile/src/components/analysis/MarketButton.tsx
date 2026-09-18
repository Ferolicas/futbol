import { Pressable, StyleSheet, View } from 'react-native';
import { Check } from 'lucide-react-native';
import { AppText, ProgressBar } from '@/components/ui';
import { MarketOutcomeBadge } from './MarketOutcomeBadge';
import { displayBettingText } from '@/shared/display-betting-text';
import { cap } from '@/lib/format';
import { colors, radius } from '@/theme/tokens';

interface Props {
  name: string;
  probability: number;
  odd?: number | null;
  bookmaker?: string | null;
  reliability?: number | null;
  expectedValue?: number | null;
  validation?: string | null;
  selected?: boolean;
  onPress?: () => void;
  outcome?: { status?: string } | null;
  pendingLabel?: string | null;
}

/** Tarjeta de mercado seleccionable (fútbol, béisbol y multideporte comparten aspecto). */
export function MarketButton({ name, probability, odd, bookmaker, reliability, expectedValue, validation, selected, onPress, outcome, pendingLabel }: Props) {
  const pct = cap(probability);
  const color = pct >= 75 ? colors.accent : pct >= 50 ? colors.warning : colors.muted;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      style={({ pressed }) => [styles.box, selected && styles.selected, pressed && onPress ? { opacity: 0.85 } : null]}
    >
      <AppText variant="label" weight="bold">{displayBettingText(name)}</AppText>
      {validation ? <AppText variant="caption" tone={validation.startsWith('Recomendación') ? 'accent' : 'muted'}>{validation}</AppText> : null}
      <MarketOutcomeBadge outcome={outcome} pendingLabel={pendingLabel} compact />
      <ProgressBar value={pct} color={color} />
      <View style={styles.nums}>
        <AppText variant="mono" weight="bold" style={{ color }}>{pct}%</AppText>
        {odd ? <AppText variant="mono" style={{ color: colors.amber }}>{Number(odd).toFixed(2)}</AppText> : null}
        {reliability != null && Number.isFinite(Number(reliability)) ? <AppText variant="caption" tone="cyan">Fiab. {Number(reliability).toFixed(1)}%</AppText> : null}
        {expectedValue != null && Number.isFinite(Number(expectedValue)) ? <AppText variant="caption" tone="faint">EV {Number(expectedValue) >= 0 ? '+' : ''}{(Number(expectedValue) * 100).toFixed(1)}%</AppText> : null}
        {bookmaker ? <AppText variant="caption" tone="muted" style={{ marginLeft: 'auto' }}>{bookmaker}</AppText> : null}
        {selected ? <View style={styles.check}><Check size={12} color={colors.onAccent} /></View> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { gap: 6, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.03)' },
  selected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  nums: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  check: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
});
