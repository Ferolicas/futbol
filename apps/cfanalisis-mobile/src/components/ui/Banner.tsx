import { Pressable, StyleSheet, View } from 'react-native';
import { X } from 'lucide-react-native';
import { AppText } from './Text';
import { colors, radius } from '@/theme/tokens';

export function Banner({ tone = 'info', message, onClose }: { tone?: 'info' | 'warning' | 'error' | 'success'; message: string; onClose?: () => void }) {
  return (
    <View style={[styles.base, styles[tone]]}>
      <AppText variant="label" tone={tone === 'error' ? 'error' : tone === 'warning' ? 'warning' : tone === 'success' ? 'accent' : 'secondary'} style={{ flex: 1 }}>{message}</AppText>
      {onClose ? <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Cerrar"><X size={16} color={colors.muted} /></Pressable> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  base: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: radius.md, borderWidth: 1 },
  info: { backgroundColor: 'rgba(255,255,255,0.04)', borderColor: colors.border },
  success: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  warning: { backgroundColor: colors.warningSoft, borderColor: 'rgba(251,191,36,0.35)' },
  error: { backgroundColor: colors.errorSoft, borderColor: 'rgba(251,113,133,0.35)' },
});
