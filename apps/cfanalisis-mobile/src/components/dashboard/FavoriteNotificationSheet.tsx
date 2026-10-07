import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Bell, Check, Star, X } from 'lucide-react-native';
import { AppText, Button } from '@/components/ui';
import { colors, radius } from '@/theme/tokens';

export const FOOTBALL_NOTIFICATION_OPTIONS = [
  ['goals', 'Goles'],
  ['corners', 'Córners'],
  ['shots', 'Remates'],
  ['shots_on_target', 'Remates a puerta'],
  ['cards', 'Tarjetas'],
  ['penalties', 'Penaltis'],
  ['substitutions', 'Cambios'],
  ['fouls', 'Faltas'],
] as const;

export type FootballNotificationPreference = typeof FOOTBALL_NOTIFICATION_OPTIONS[number][0];

interface Props {
  visible: boolean;
  home?: string;
  away?: string;
  isFavorite: boolean;
  selected: FootballNotificationPreference[];
  saving?: boolean;
  onChange: (next: FootballNotificationPreference[]) => void;
  onSave: () => void;
  onRemove: () => void;
  onClose: () => void;
}

export function FavoriteNotificationSheet({ visible, home, away, isFavorite, selected, saving, onChange, onSave, onRemove, onClose }: Props) {
  const allSelected = selected.length === FOOTBALL_NOTIFICATION_OPTIONS.length;
  const toggle = (key: FootballNotificationPreference) => {
    onChange(selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key]);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={saving ? undefined : onClose} accessibilityLabel="Cerrar preferencias" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.heading}>
            <View style={styles.icon}><Bell size={20} color={colors.accent} /></View>
            <View style={{ flex: 1 }}>
              <AppText variant="title" weight="bold">Notificaciones</AppText>
              <AppText variant="caption" tone="muted" numberOfLines={1}>{home || 'Local'} vs {away || 'Visitante'}</AppText>
            </View>
            <Pressable onPress={onClose} disabled={saving} hitSlop={10} accessibilityLabel="Cerrar">
              <X size={22} color={colors.muted} />
            </Pressable>
          </View>

          <AppText variant="caption" tone="secondary">Elige uno, varios o ningún evento. Podrás cambiarlo tocando de nuevo la estrella.</AppText>

          <View style={styles.quickRow}>
            <Pressable style={[styles.quick, allSelected && styles.quickActive]} onPress={() => onChange(FOOTBALL_NOTIFICATION_OPTIONS.map(([key]) => key))}>
              <AppText variant="label" weight="bold" tone={allSelected ? 'accent' : 'muted'}>Todos</AppText>
            </Pressable>
            <Pressable style={[styles.quick, selected.length === 0 && styles.quickActive]} onPress={() => onChange([])}>
              <AppText variant="label" weight="bold" tone={selected.length === 0 ? 'accent' : 'muted'}>Ninguno</AppText>
            </Pressable>
          </View>

          <ScrollView style={styles.options} contentContainerStyle={styles.optionsContent} showsVerticalScrollIndicator={false}>
            {FOOTBALL_NOTIFICATION_OPTIONS.map(([key, label]) => {
              const active = selected.includes(key);
              return (
                <Pressable key={key} onPress={() => toggle(key)} style={[styles.option, active && styles.optionActive]} accessibilityRole="checkbox" accessibilityState={{ checked: active }}>
                  <AppText variant="label" weight="bold" tone={active ? 'accent' : 'secondary'}>{label}</AppText>
                  <View style={[styles.check, active && styles.checkActive]}>{active ? <Check size={15} color={colors.onAccent} strokeWidth={3} /> : null}</View>
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={styles.actions}>
            {isFavorite ? <Button title="Quitar favorito" variant="danger" disabled={saving} onPress={onRemove} icon={<Star size={16} color={colors.error} />} style={{ flex: 1 }} /> : null}
            <Button title={isFavorite ? 'Guardar' : 'Agregar favorito'} loading={saving} onPress={onSave} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.7)' },
  sheet: { maxHeight: '88%', gap: 14, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 28, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.accentBorder, backgroundColor: colors.surfaceSolid },
  handle: { alignSelf: 'center', width: 42, height: 4, borderRadius: radius.pill, backgroundColor: colors.borderStrong },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder },
  quickRow: { flexDirection: 'row', gap: 10 },
  quick: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.03)' },
  quickActive: { borderColor: colors.accentBorder, backgroundColor: colors.accentSoft },
  options: { flexGrow: 0 },
  optionsContent: { gap: 8 },
  option: { minHeight: 46, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.025)' },
  optionActive: { borderColor: colors.accentBorder, backgroundColor: colors.accentSoft },
  check: { width: 22, height: 22, borderRadius: 7, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.borderStrong },
  checkActive: { borderColor: colors.accent, backgroundColor: colors.accent },
  actions: { flexDirection: 'row', gap: 10 },
});
