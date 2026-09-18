import { ScrollView, StyleSheet } from 'react-native';
import { Chip } from '@/components/ui';

export interface ChoiceItem { key: string; label: string; color?: string; count?: number | null; icon?: React.ReactNode }

/** Barra horizontal deslizable de pestañas/filtros (tabs del análisis). */
export function HorizontalChoiceBar({ items, active, onChange, small }: { items: ChoiceItem[]; active: string; onChange: (key: string) => void; small?: boolean }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps="handled">
      {items.map((item) => (
        <Chip key={item.key} label={item.label} active={active === item.key} onPress={() => onChange(item.key)} color={item.color} count={item.count} icon={item.icon} small={small} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({ row: { gap: 6, paddingVertical: 2 } });
