import { useEffect, useMemo, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { AppText } from '@/components/ui';
import { shiftIsoDay } from '@/lib/timezone';
import { colors, radius } from '@/theme/tokens';

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function compactDay(date: string) {
  const [year, month, day] = String(date).split('-').map(Number);
  const value = new Date(year, month - 1, day, 12);
  return { weekday: WEEKDAYS[value.getDay()], calendar: `${value.getDate()} ${MONTHS[value.getMonth()]}` };
}

/** Mañana, hoy y los diez días anteriores; solo la jornada seleccionada va en verde. */
export function DateStrip({ today, value, onChange }: { today: string; value: string; onChange: (date: string) => void }) {
  const dates = useMemo(() => Array.from({ length: 12 }, (_, index) => shiftIsoDay(today, 1 - index)), [today]);
  const scrollRef = useRef<ScrollView>(null);
  useEffect(() => {
    const index = dates.indexOf(value);
    if (index > 1) scrollRef.current?.scrollTo({ x: Math.max(0, (index - 1) * 74), animated: true });
  }, [dates, value]);

  return (
    <ScrollView ref={scrollRef} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.track} accessibilityLabel="Elegir jornada">
      {dates.map((date) => {
        const label = compactDay(date);
        const isToday = date === today;
        const selected = date === value;
        return (
          <Pressable
            key={date}
            onPress={() => onChange(date)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`${isToday ? 'Hoy, ' : ''}${label.weekday} ${label.calendar}`}
            style={({ pressed }) => [styles.tile, selected && styles.selected, pressed && { opacity: 0.8 }]}
          >
            <AppText variant="kicker" size={10} tone={selected ? 'default' : 'muted'} style={selected ? { color: colors.onAccent } : null}>{isToday ? 'hoy' : label.weekday}</AppText>
            <AppText variant="label" weight="bold" size={12.5} style={{ color: selected ? colors.onAccent : colors.text }}>{label.calendar}</AppText>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  track: { gap: 6, paddingHorizontal: 16, paddingVertical: 4 },
  tile: { width: 68, paddingVertical: 8, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.03)', alignItems: 'center', gap: 2 },
  selected: { backgroundColor: colors.accent, borderColor: colors.accent },
});
