import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './Text';
import { colors, radius } from '@/theme/tokens';

interface Props {
  label: string;
  active?: boolean;
  onPress?: () => void;
  icon?: React.ReactNode;
  count?: number | null;
  color?: string;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
}

/** Chip/pestaña con estado activo por color, borde y fondo (nunca solo color). */
export function Chip({ label, active, onPress, icon, count, color = colors.accent, style, small }: Props) {
  const content = (
    <View style={[styles.chip, small && styles.small, active && { borderColor: color, backgroundColor: `${color}22` }, style]}>
      {icon}
      <AppText variant="label" size={small ? 12 : 13} tone={active ? 'default' : 'secondary'} style={active ? { color } : null} numberOfLines={1}>
        {label}
      </AppText>
      {count != null && count > 0 && (
        <View style={[styles.count, active && { backgroundColor: color }]}>
          <AppText variant="mono" size={10.5} style={{ color: active ? colors.onAccent : colors.muted }}>{count > 99 ? '99+' : count}</AppText>
        </View>
      )}
    </View>
  );
  if (!onPress) return content;
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: !!active }} style={({ pressed }) => pressed && { opacity: 0.8 }}>{content}</Pressable>;
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.03)' },
  small: { paddingVertical: 5, paddingHorizontal: 10 },
  count: { minWidth: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
});
