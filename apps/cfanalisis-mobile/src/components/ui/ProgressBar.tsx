import { StyleSheet, View } from 'react-native';
import { colors } from '@/theme/tokens';

export function ProgressBar({ value, color = colors.accent, height = 5 }: { value: number; color?: string; height?: number }) {
  const width = `${Math.max(0, Math.min(100, Number(value) || 0))}%` as const;
  return (
    <View style={[styles.track, { height, borderRadius: height }]}>
      <View style={[styles.fill, { width, backgroundColor: color, borderRadius: height }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { width: '100%', backgroundColor: 'rgba(255,255,255,0.07)', overflow: 'hidden' },
  fill: { height: '100%' },
});
