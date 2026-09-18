import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, ChevronDown, Trophy, X } from 'lucide-react-native';
import { AppText, TeamLogo } from '@/components/ui';
import { DASHBOARD_SPORTS, SPORT_ICONS, type SportKey } from './SportIcons';
import { leagueSelectionIncludes, normalizeLeagueSelection, toggleLeagueSelection } from '@/shared/league-view-filter';
import { colors, radius } from '@/theme/tokens';

export interface LeagueOption { id: string | number; name: string; country?: string | null; logo?: string | null }

function Trigger({ label, value, leading, count, onPress, disabled }: { label: string; value: string; leading: React.ReactNode; count?: number | null; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" style={({ pressed }) => [styles.trigger, pressed && { opacity: 0.85 }, disabled && { opacity: 0.6 }]}>
      <View style={styles.leading}>{leading}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText variant="kicker" size={9.5} tone="muted">{label}</AppText>
        <AppText variant="label" weight="bold" size={12.5} numberOfLines={1}>{value}</AppText>
      </View>
      {count != null && count > 0 && <View style={styles.count}><AppText variant="mono" size={10} tone="accent">{count}</AppText></View>}
      <ChevronDown size={15} color={colors.muted} />
    </Pressable>
  );
}

function Sheet({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={styles.sheetHead}>
          <AppText variant="heading">{title}</AppText>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Cerrar"><X size={20} color={colors.muted} /></Pressable>
        </View>
        {children}
      </View>
    </Modal>
  );
}

export function SportPicker({ value, onChange }: { value: SportKey; onChange: (sport: SportKey) => void }) {
  const [open, setOpen] = useState(false);
  const selected = DASHBOARD_SPORTS.find((item) => item.value === value) || DASHBOARD_SPORTS[0];
  const Icon = SPORT_ICONS[selected.value];
  return (
    <>
      <Trigger label="Deporte" value={selected.label} leading={<Icon size={18} color={colors.accent} />} onPress={() => setOpen(true)} />
      <Sheet visible={open} title="Deporte" onClose={() => setOpen(false)}>
        {DASHBOARD_SPORTS.map((item) => {
          const ItemIcon = SPORT_ICONS[item.value];
          const active = item.value === value;
          return (
            <Pressable key={item.value} onPress={() => { onChange(item.value); setOpen(false); }} style={({ pressed }) => [styles.option, active && styles.optionActive, pressed && { opacity: 0.85 }]}>
              <ItemIcon size={20} color={active ? colors.accent : colors.text} />
              <View style={{ flex: 1 }}>
                <AppText variant="label" weight="bold">{item.label}</AppText>
                <AppText variant="caption" tone="muted">{item.meta}</AppText>
              </View>
              {active && <Check size={16} color={colors.accent} />}
            </Pressable>
          );
        })}
      </Sheet>
    </>
  );
}

/** Selector simple (béisbol, baloncesto, fútbol americano): una competición o todas. */
export function LeaguePicker({ leagues, value, onChange }: { leagues: LeagueOption[]; value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const selected = leagues.find((league) => String(league.id) === String(value));
  return (
    <>
      <Trigger
        label="Competición"
        value={selected?.name || 'Todas las ligas'}
        leading={selected?.logo ? <TeamLogo src={selected.logo} name={selected.name} size={20} /> : <Trophy size={18} color={colors.accent} />}
        onPress={() => setOpen(true)}
      />
      <Sheet visible={open} title="Competición" onClose={() => setOpen(false)}>
        <FlatList
          data={[{ id: '', name: 'Todas las ligas', country: 'Sin limitar competiciones' } as LeagueOption, ...leagues]}
          keyExtractor={(item) => String(item.id || 'all')}
          style={{ maxHeight: 420 }}
          renderItem={({ item }) => {
            const active = String(item.id) === String(value);
            return (
              <Pressable onPress={() => { onChange(String(item.id)); setOpen(false); }} style={({ pressed }) => [styles.option, active && styles.optionActive, pressed && { opacity: 0.85 }]}>
                {item.logo ? <TeamLogo src={item.logo} name={item.name} size={22} /> : <Trophy size={18} color={active ? colors.accent : colors.muted} />}
                <View style={{ flex: 1 }}>
                  <AppText variant="label" weight="bold">{item.name}</AppText>
                  {item.country ? <AppText variant="caption" tone="muted">{item.country}</AppText> : null}
                </View>
                {active && <Check size={16} color={colors.accent} />}
              </Pressable>
            );
          }}
        />
      </Sheet>
    </>
  );
}

interface MultiProps {
  leagues: LeagueOption[];
  value: string[] | null;
  onChange: (value: string[] | null) => void;
  allLeagueIds: string[];
  disabled?: boolean;
  saving?: boolean;
}

/** Fútbol: multiselección persistida; null = todas, [] = ninguna. */
export function LeagueMultiPicker({ leagues, value, onChange, allLeagueIds, disabled, saving }: MultiProps) {
  const [open, setOpen] = useState(false);
  const normalized = useMemo(() => normalizeLeagueSelection(value), [value]);
  const selectedSet = useMemo(() => new Set(normalized || []), [normalized]);
  const availableSelected = normalized === null ? leagues.length : leagues.filter((league) => selectedSet.has(String(league.id))).length;
  const singleLeague = availableSelected === 1 ? leagues.find((league) => leagueSelectionIncludes(normalized, league.id)) : null;
  const summary = disabled ? 'Cargando ligas…' : normalized === null ? 'Todas las ligas' : normalized.length === 0 ? 'Ninguna liga' : singleLeague?.name || `${availableSelected} ligas visibles`;

  const toggle = (leagueId: string | number) => {
    const known = allLeagueIds.length ? allLeagueIds : leagues.map((league) => String(league.id));
    onChange(toggleLeagueSelection(normalized, leagueId, known));
  };

  return (
    <>
      <Trigger
        label="Competición"
        value={summary}
        count={disabled ? null : availableSelected}
        disabled={disabled}
        leading={singleLeague?.logo ? <TeamLogo src={singleLeague.logo} name={singleLeague.name} size={20} /> : <Trophy size={18} color={colors.accent} />}
        onPress={() => setOpen(true)}
      />
      <Sheet visible={open} title="Filtrar ligas visibles" onClose={() => setOpen(false)}>
        <View style={styles.actions}>
          <Pressable onPress={() => onChange(null)} style={styles.actionBtn}><AppText variant="label" tone="accent">Todas</AppText></Pressable>
          <Pressable onPress={() => onChange([])} style={styles.actionBtn}><AppText variant="label" tone="accent">Ninguna</AppText></Pressable>
          <AppText variant="caption" tone="muted" style={{ marginLeft: 'auto' }}>{saving ? 'Guardando…' : `${availableSelected}/${leagues.length} visibles`}</AppText>
        </View>
        <FlatList
          data={leagues}
          keyExtractor={(item) => String(item.id)}
          style={{ maxHeight: 440 }}
          renderItem={({ item }) => {
            const checked = leagueSelectionIncludes(normalized, item.id);
            return (
              <Pressable onPress={() => toggle(item.id)} accessibilityRole="checkbox" accessibilityState={{ checked }} style={({ pressed }) => [styles.option, checked && styles.optionActive, pressed && { opacity: 0.85 }]}>
                <View style={[styles.checkbox, checked && { backgroundColor: colors.accent, borderColor: colors.accent }]}>{checked && <Check size={13} color={colors.onAccent} />}</View>
                {item.logo ? <TeamLogo src={item.logo} name={item.name} size={22} /> : <Trophy size={18} color={colors.muted} />}
                <View style={{ flex: 1 }}>
                  <AppText variant="label" weight="bold">{item.name}</AppText>
                  <AppText variant="caption" tone="muted">{item.country || 'Competición'}</AppText>
                </View>
              </Pressable>
            );
          }}
        />
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSolid },
  leading: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
  count: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: colors.accentSoft },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { backgroundColor: colors.surfaceSolid, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 16, paddingTop: 14, borderTopWidth: 1, borderColor: colors.border, maxHeight: '82%' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, paddingHorizontal: 10, borderRadius: radius.md, marginBottom: 4 },
  optionActive: { backgroundColor: colors.accentSoft },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  actionBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.accentBorder, backgroundColor: colors.accentSoft },
  checkbox: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
});
