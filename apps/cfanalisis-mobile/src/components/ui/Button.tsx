import { ActivityIndicator, Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './Text';
import { colors, radius } from '@/theme/tokens';

interface Props extends Omit<PressableProps, 'style'> {
  title: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function Button({ title, variant = 'primary', size = 'md', loading, icon, style, disabled, ...rest }: Props) {
  const isDisabled = disabled || loading;
  const textTone = variant === 'primary' ? 'white' : variant === 'danger' ? 'error' : variant === 'secondary' ? 'accent' : 'secondary';
  return (
    <Pressable
      {...rest}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        styles[`size_${size}`],
        pressed && { opacity: 0.82, transform: [{ scale: 0.985 }] },
        isDisabled && { opacity: 0.55 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={variant === 'primary' ? colors.onAccent : colors.accent} /> : (
        <View style={styles.row}>
          {icon}
          <AppText
            variant="label"
            weight="bold"
            tone={textTone}
            style={variant === 'primary' ? { color: colors.onAccent } : null}
            size={size === 'sm' ? 12.5 : size === 'lg' ? 15 : 13.5}
          >
            {title}
          </AppText>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'transparent' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  secondary: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  ghost: { backgroundColor: 'rgba(255,255,255,0.04)', borderColor: colors.border },
  danger: { backgroundColor: colors.errorSoft, borderColor: 'rgba(251,113,133,0.35)' },
  size_sm: { paddingVertical: 7, paddingHorizontal: 12 },
  size_md: { paddingVertical: 12, paddingHorizontal: 16 },
  size_lg: { paddingVertical: 15, paddingHorizontal: 20 },
});
