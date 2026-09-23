import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { EyeOff, RotateCcw, TriangleAlert, X } from 'lucide-react-native';
import { AppText } from '@/components/ui';
import { fmtDateTime } from '@/lib/timezone';
import { colors, radius } from '@/theme/tokens';

/** Partido oculto normalizado (fútbol y béisbol). */
export interface HiddenFixture { id: number; home: string; away: string; date?: string | null }

interface ConfirmProps {
  visible: boolean;
  home?: string | null;
  away?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** Sin Modal propio: capa absoluta para montarla dentro de otro Modal (fullscreen). */
  inline?: boolean;
}

// Confirmación antes de ocultar — la X abre esto en vez de ocultar directo
// (igual que DismissConfirmDialog en la web).
export function DismissConfirmDialog({ visible, home, away, onCancel, onConfirm, inline = false }: ConfirmProps) {
  if (!visible && inline) return null;
  const name = home || 'este partido';
  const content = (
    <View style={[styles.overlay, inline && StyleSheet.absoluteFill]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} accessibilityLabel="Cancelar" />
      <View style={styles.dialog} accessibilityRole="alert">
        <View style={styles.warnIcon}><TriangleAlert size={22} color={colors.warning} /></View>
        <AppText variant="heading" align="center">¿Ocultar este partido?</AppText>
        <AppText tone="secondary" align="center">
          Vas a ocultar <AppText weight="bold">{away ? `${name} vs ${away}` : name}</AppText> de tu lista. Podés recuperarlo después desde &quot;Ocultos&quot;.
        </AppText>
        <View style={styles.actions}>
          <Pressable onPress={onCancel} style={({ pressed }) => [styles.btn, styles.cancel, pressed && { opacity: 0.8 }]} accessibilityRole="button">
            <AppText variant="label" weight="bold">Cancelar</AppText>
          </Pressable>
          <Pressable onPress={onConfirm} style={({ pressed }) => [styles.btn, styles.confirm, pressed && { opacity: 0.8 }]} accessibilityRole="button">
            <AppText variant="label" weight="bold" style={{ color: colors.white }}>Ocultar</AppText>
          </Pressable>
        </View>
      </View>
    </View>
  );
  if (inline) return content;
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>{content}</Modal>;
}

/** Botón compacto "Ocultos (N)" para la fila de filtros; solo si N>0. */
export function HiddenFixturesButton({ count, onPress }: { count: number; onPress: () => void }) {
  if (count <= 0) return null;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Ocultos (${count})`} style={({ pressed }) => [styles.trigger, pressed && { opacity: 0.85 }]}>
      <EyeOff size={16} color={colors.muted} />
      <AppText variant="mono" size={11} tone="secondary">{count}</AppText>
    </Pressable>
  );
}

interface PanelProps { visible: boolean; fixtures: HiddenFixture[]; userTz: string; onUnhide: (id: number) => void; onClose: () => void }

// Panel para ver y recuperar partidos ocultados.
export function HiddenFixturesPanel({ visible, fixtures, userTz, onUnhide, onClose }: PanelProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Cerrar" />
        <View style={[styles.dialog, styles.panel]}>
          <View style={styles.panelHead}>
            <EyeOff size={18} color={colors.accent} />
            <AppText variant="heading" style={{ flex: 1 }}>Partidos ocultos</AppText>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Cerrar"><X size={18} color={colors.muted} /></Pressable>
          </View>
          {fixtures.length === 0 ? (
            <AppText tone="muted">No tenés partidos ocultos hoy.</AppText>
          ) : (
            <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 8 }}>
              {fixtures.map((f) => (
                <View key={f.id} style={styles.item}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <AppText variant="label" weight="bold" numberOfLines={2}>{f.home} vs {f.away}</AppText>
                    {!!f.date && <AppText variant="caption" tone="muted">{fmtDateTime(f.date, userTz || 'UTC')}</AppText>}
                  </View>
                  <Pressable onPress={() => onUnhide(f.id)} style={({ pressed }) => [styles.restore, pressed && { opacity: 0.8 }]} accessibilityRole="button" accessibilityLabel={`Recuperar ${f.home} vs ${f.away}`}>
                    <RotateCcw size={14} color={colors.accent} />
                    <AppText variant="caption" weight="bold" tone="accent">Recuperar</AppText>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 50, elevation: 50 },
  dialog: { width: '100%', maxWidth: 380, padding: 20, gap: 12, borderRadius: radius.xl, backgroundColor: colors.surfaceSolid, borderWidth: 1, borderColor: colors.borderStrong, alignItems: 'center' },
  warnIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.warningSoft },
  actions: { flexDirection: 'row', gap: 10, alignSelf: 'stretch', marginTop: 4 },
  btn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: radius.md },
  cancel: { backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: colors.border },
  confirm: { backgroundColor: '#e11d48' },
  trigger: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSolid },
  panel: { alignItems: 'stretch' },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.03)' },
  restore: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 7, paddingHorizontal: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.accentBorder, backgroundColor: colors.accentSoft },
});
