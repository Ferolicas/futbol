import { StyleSheet, View, type ViewProps } from 'react-native';
import { colors, radius } from '@/theme/tokens';

interface Props extends ViewProps {
  tone?: 'default' | 'strong' | 'accent' | 'warning' | 'error';
  padded?: boolean;
}

export function Card({ tone = 'default', padded = true, style, ...rest }: Props) {
  return <View {...rest} style={[styles.base, styles[tone], padded && styles.padded, style]} />;
}

const styles = StyleSheet.create({
  base: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSolid },
  padded: { padding: 14 },
  default: {},
  strong: { backgroundColor: colors.surfaceStrong },
  accent: { backgroundColor: 'rgba(94,230,177,0.06)', borderColor: colors.accentBorder },
  warning: { backgroundColor: colors.warningSoft, borderColor: 'rgba(251,191,36,0.35)' },
  error: { backgroundColor: colors.errorSoft, borderColor: 'rgba(251,113,133,0.35)' },
});
