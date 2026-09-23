import { Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Sparkles } from 'lucide-react-native';
import { AppText } from '@/components/ui';
import { colors, radius } from '@/theme/tokens';

// Alto del StatusDock sin inset (paddingTop 8 + ícono 42 + gap 3 + etiqueta ~14 + 4).
const DOCK_BASE = 71;
// "Ver combinada" (floatBar) va a bottom:92 y mide ~60.
const COMBO_BAR_TOP = 92 + 60;

/** Pastilla flotante "Preguntar" (como .match-assistant-launcher de la web). Solo en el dashboard. */
export function AssistantLauncher({ lifted = false }: { lifted?: boolean }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const dockTop = DOCK_BASE + Math.max(insets.bottom, 8);
  const bottom = lifted ? Math.max(COMBO_BAR_TOP, dockTop) + 10 : dockTop + 14;
  return (
    <Pressable
      onPress={() => router.push('/assistant')}
      accessibilityRole="button"
      accessibilityLabel="Preguntar al asistente"
      style={({ pressed }) => [styles.pill, { bottom }, pressed && { opacity: 0.88, transform: [{ scale: 0.97 }] }]}
    >
      <Sparkles size={16} color={colors.onAccent} />
      <AppText variant="label" weight="bold" style={{ color: colors.onAccent }}>Preguntar</AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: { position: 'absolute', right: 16, flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 16, borderRadius: radius.pill, backgroundColor: colors.accent, shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 10 },
});
