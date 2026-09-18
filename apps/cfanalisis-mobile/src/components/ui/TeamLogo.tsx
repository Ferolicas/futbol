import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { AppText } from './Text';
import { assetUrl } from '@/lib/config';
import { colors } from '@/theme/tokens';

interface Props { src?: string | null; fallbackSrc?: string | null; name?: string | null; size?: number; rounded?: boolean }

export function TeamLogo({ src, fallbackSrc, name, size = 36, rounded }: Props) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src, fallbackSrc]);
  const uri = assetUrl(failed ? fallbackSrc : (src || fallbackSrc));
  if (!uri || (failed && !fallbackSrc)) {
    return (
      <View style={[styles.fallback, { width: size, height: size, borderRadius: rounded ? size / 2 : Math.max(6, size * 0.22) }]}>
        <AppText variant="label" weight="bold" tone="muted" size={Math.max(9, size * 0.34)}>{String(name || '?').slice(0, 2).toUpperCase()}</AppText>
      </View>
    );
  }
  return (
    <Image
      source={{ uri }}
      style={{ width: size, height: size, borderRadius: rounded ? size / 2 : 0 }}
      contentFit="contain"
      cachePolicy="disk"
      transition={120}
      onError={() => setFailed(true)}
      accessibilityLabel={name || undefined}
    />
  );
}

const styles = StyleSheet.create({
  fallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: colors.border },
});
