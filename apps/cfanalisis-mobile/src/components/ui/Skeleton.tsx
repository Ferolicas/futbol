import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radius } from '@/theme/tokens';

export function Skeleton({ height = 96, style }: { height?: number; style?: StyleProp<ViewStyle> }) {
  const opacity = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 0.9, duration: 700, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0.45, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View style={[styles.base, { height, opacity }, style]} />;
}

export function SkeletonList({ count = 5, height = 120 }: { count?: number; height?: number }) {
  return (
    <View style={{ gap: 10 }}>
      {Array.from({ length: count }, (_, index) => <Skeleton key={index} height={height} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: colors.border },
});
