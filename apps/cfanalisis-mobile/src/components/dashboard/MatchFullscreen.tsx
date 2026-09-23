import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronDown, ChevronUp, X } from 'lucide-react-native';
import { AppText } from '@/components/ui';
import { colors } from '@/theme/tokens';

interface Props {
  visible: boolean;
  head: React.ReactNode;
  body: React.ReactNode;
  onClose: () => void;
  onStep?: ((direction: 1 | -1) => void) | null;
  title?: string;
  /** Capa sobre el partido (p.ej. confirmación de ocultar) dentro del mismo Modal: en iOS dos Modals de árboles distintos no se apilan bien. */
  overlay?: React.ReactNode;
}

/**
 * Partido desplegado a pantalla completa: la cabecera queda fija y solo se
 * desplaza el bloque de datos; las flechas cambian de partido analizado.
 */
export function MatchFullscreen({ visible, head, body, onClose, onStep, title = 'Partido', overlay }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.topbar}>
          <AppText variant="kicker" tone="muted">{title}</AppText>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Cerrar partido" style={styles.closeBtn}>
            <X size={18} color={colors.text} />
          </Pressable>
        </View>
        <View style={styles.head}>{head}</View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: insets.bottom + 90, gap: 12 }} showsVerticalScrollIndicator={false}>
          {body}
        </ScrollView>
        {onStep && (
          <View style={[styles.nav, { bottom: insets.bottom + 14 }]}>
            <Pressable onPress={() => onStep(-1)} style={styles.navBtn} accessibilityLabel="Partido anterior"><ChevronUp size={20} color={colors.text} /></Pressable>
            <Pressable onPress={() => onStep(1)} style={styles.navBtn} accessibilityLabel="Partido siguiente"><ChevronDown size={20} color={colors.text} /></Pressable>
          </View>
        )}
        {overlay}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8 },
  closeBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: colors.border },
  head: { paddingHorizontal: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  nav: { position: 'absolute', right: 14, gap: 8 },
  navBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.borderStrong },
});
