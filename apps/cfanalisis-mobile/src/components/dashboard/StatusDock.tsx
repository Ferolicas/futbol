import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CalendarDays, CircleCheck, Clock3, RadioTower, Star } from 'lucide-react-native';
import { AppText } from '@/components/ui';
import { colors } from '@/theme/tokens';

export type StatusFilter = 'all' | 'upcoming' | 'live' | 'finished' | 'favoritos';
export interface StatusCounts { all?: number; upcoming?: number; live?: number; finished?: number; favorites?: number }

interface Props { value: StatusFilter; onChange: (value: StatusFilter) => void; counts: StatusCounts; isToday: boolean; onToday: () => void }

/** Dock inferior: Hoy → Próximos → En vivo → Finalizados → Favoritos. */
export function StatusDock({ value, onChange, counts, isToday, onToday }: Props) {
  const insets = useSafeAreaInsets();
  const items = [
    { key: 'today', label: 'Hoy', Icon: CalendarDays, count: counts.all },
    { key: 'upcoming', label: 'Próximos', Icon: Clock3, count: counts.upcoming },
    { key: 'live', label: 'En vivo', Icon: RadioTower, count: counts.live, live: true },
    { key: 'finished', label: 'Finalizados', Icon: CircleCheck, count: counts.finished },
    { key: 'favoritos', label: 'Favoritos', Icon: Star, count: counts.favorites },
  ] as const;

  return (
    <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {items.map((item) => {
        const active = item.key === 'today' ? (isToday && value === 'all') : value === item.key;
        const isLive = 'live' in item && item.live;
        const color = active ? (isLive ? colors.white : colors.accent) : colors.muted;
        return (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => { if (item.key === 'today') { onToday(); onChange('all'); } else onChange(item.key); }}
            style={({ pressed }) => [styles.item, pressed && { opacity: 0.8 }]}
          >
            <View style={[styles.iconWrap, isLive && styles.liveWrap, isLive && active && styles.liveActive, !isLive && active && styles.activeWrap]}>
              <item.Icon size={isLive ? 24 : 20} color={color} />
              {Number(item.count) > 0 && (
                <View style={styles.badge}><AppText variant="mono" size={9.5} style={{ color: colors.onAccent }}>{Number(item.count) > 99 ? '99+' : item.count}</AppText></View>
              )}
            </View>
            <AppText variant="caption" size={10.5} weight={active ? 'bold' : 'medium'} style={{ color: active ? colors.accent : colors.muted }}>{item.label}</AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-around', paddingTop: 8, paddingHorizontal: 6, backgroundColor: colors.surfaceStrong, borderTopWidth: 1, borderTopColor: colors.border },
  item: { alignItems: 'center', gap: 3, minWidth: 60, paddingVertical: 2 },
  iconWrap: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  activeWrap: { backgroundColor: colors.accentSoft },
  liveWrap: { width: 52, height: 52, borderRadius: 26, marginTop: -22, backgroundColor: '#3a0f16', borderWidth: 2, borderColor: 'rgba(239,68,68,0.55)' },
  liveActive: { backgroundColor: colors.live, borderColor: colors.live },
  badge: { position: 'absolute', top: -2, right: -4, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
});
