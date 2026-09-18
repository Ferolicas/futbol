import { StyleSheet, View } from 'react-native';
import { AppText } from './Text';
import { Button } from './Button';
import { colors, radius } from '@/theme/tokens';

interface Props {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ icon, title, description, actionLabel, onAction }: Props) {
  return (
    <View style={styles.box}>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <AppText variant="heading" align="center">{title}</AppText>
      {description ? <AppText tone="muted" align="center">{description}</AppText> : null}
      {actionLabel && onAction ? <Button title={actionLabel} variant="secondary" onPress={onAction} style={{ marginTop: 6 }} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', gap: 8, padding: 28, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.02)' },
  icon: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft, marginBottom: 4 },
});
