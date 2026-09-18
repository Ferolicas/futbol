import { Text as RNText, StyleSheet, type TextProps, type TextStyle } from 'react-native';
import { colors, fonts } from '@/theme/tokens';

type Variant = 'body' | 'title' | 'heading' | 'label' | 'caption' | 'mono' | 'kicker';
type Tone = 'default' | 'secondary' | 'muted' | 'accent' | 'error' | 'warning' | 'cyan' | 'white' | 'faint';

interface Props extends TextProps {
  variant?: Variant;
  tone?: Tone;
  weight?: 'medium' | 'semibold' | 'bold' | 'extra';
  align?: TextStyle['textAlign'];
  size?: number;
}

const toneColor: Record<Tone, string> = {
  default: colors.text,
  secondary: colors.textSecondary,
  muted: colors.muted,
  faint: colors.faint,
  accent: colors.accent,
  error: colors.error,
  warning: colors.warning,
  cyan: colors.cyan,
  white: colors.white,
};

const weightFont = {
  medium: fonts.sans,
  semibold: fonts.sansSemibold,
  bold: fonts.sansBold,
  extra: fonts.sansExtra,
};

export function AppText({ variant = 'body', tone = 'default', weight, align, size, style, ...rest }: Props) {
  const base = styles[variant];
  const family = variant === 'mono'
    ? (weight === 'bold' || weight === 'extra' ? fonts.monoBold : fonts.mono)
    : (weight ? weightFont[weight] : undefined);
  return (
    <RNText
      {...rest}
      style={[base, { color: toneColor[tone] }, family ? { fontFamily: family } : null, align ? { textAlign: align } : null, size ? { fontSize: size, lineHeight: Math.round(size * 1.35) } : null, style]}
    />
  );
}

const styles = StyleSheet.create({
  body: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  title: { fontFamily: fonts.sansBold, fontSize: 22, lineHeight: 28, letterSpacing: -0.3 },
  heading: { fontFamily: fonts.sansBold, fontSize: 16, lineHeight: 22 },
  label: { fontFamily: fonts.sansSemibold, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: fonts.sans, fontSize: 11.5, lineHeight: 16 },
  kicker: { fontFamily: fonts.sansBold, fontSize: 10.5, lineHeight: 14, letterSpacing: 1, textTransform: 'uppercase' },
  mono: { fontFamily: fonts.mono, fontSize: 14, lineHeight: 18, fontVariant: ['tabular-nums'] },
});
