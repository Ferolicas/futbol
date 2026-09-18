import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { AppText } from '@/components/ui';
import { assetUrl } from '@/lib/config';
import { colors, radius } from '@/theme/tokens';

interface Props { outcome?: { status?: string } | null; pendingLabel?: string | null; compact?: boolean }

/** Sticker Ganada/Perdida (mismos assets de la web); Nula y pendientes en neutro. */
export function MarketOutcomeBadge({ outcome, pendingLabel = null, compact }: Props) {
  const status = outcome?.status;
  if (status !== 'won' && status !== 'lost') {
    const neutral = status === 'void' ? 'Nula' : pendingLabel;
    if (!neutral) return null;
    return (
      <View style={[styles.base, styles.pending]}>
        <View style={styles.dot} />
        <AppText variant="kicker" size={9.5} tone="muted">{neutral}</AppText>
      </View>
    );
  }
  const won = status === 'won';
  return (
    <View style={[styles.base, won ? styles.won : styles.lost]}>
      <Image source={{ uri: assetUrl(won ? '/daily-pick-sticker.webp' : '/daily-pick-lost-sticker.webp') || undefined }} style={{ width: compact ? 18 : 24, height: compact ? 18 : 24 }} contentFit="contain" />
      <AppText variant="kicker" size={compact ? 9.5 : 10.5} style={{ color: won ? colors.accent : colors.error }}>{won ? 'Ganada' : 'Perdida'}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', paddingVertical: 3, paddingHorizontal: 8, borderRadius: radius.pill, borderWidth: 1 },
  pending: { borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.04)' },
  won: { borderColor: colors.accentBorder, backgroundColor: colors.accentSoft },
  lost: { borderColor: 'rgba(251,113,133,0.35)', backgroundColor: colors.errorSoft },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.muted },
});
