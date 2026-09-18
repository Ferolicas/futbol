import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { AppText } from './Text';
import { colors, fonts, radius } from '@/theme/tokens';

interface Props extends TextInputProps { label?: string; icon?: React.ReactNode; hint?: string; error?: string | null }

export function Input({ label, icon, hint, error, style, ...rest }: Props) {
  return (
    <View style={{ gap: 6 }}>
      {label ? <AppText variant="label" tone="secondary">{label}</AppText> : null}
      <View style={[styles.box, error ? { borderColor: 'rgba(251,113,133,0.55)' } : null]}>
        {icon}
        <TextInput
          {...rest}
          placeholderTextColor={colors.faint}
          selectionColor={colors.accent}
          style={[styles.input, style]}
        />
      </View>
      {error ? <AppText variant="caption" tone="error">{error}</AppText> : hint ? <AppText variant="caption" tone="muted">{hint}</AppText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surfaceSolid, minHeight: 50 },
  input: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 15, paddingVertical: 12 },
});
