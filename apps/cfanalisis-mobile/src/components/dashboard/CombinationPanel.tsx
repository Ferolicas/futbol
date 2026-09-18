import { Pressable, StyleSheet, View } from 'react-native';
import { Layers, Save, Trash, X } from 'lucide-react-native';
import { AppText, Button, Card } from '@/components/ui';
import { displayBettingText } from '@/shared/display-betting-text';
import { groupSavedCombinadaSelections } from '@/shared/saved-combinada';
import { cap } from '@/lib/format';
import { colors, radius } from '@/theme/tokens';

export interface CombinationSelection {
  fixtureId: string | number;
  id?: string;
  marketKey?: string;
  matchName?: string;
  name?: string;
  market?: string;
  probability?: number;
  rawProbability?: number;
  odd?: number | null;
  bookmakerPrefix?: string;
}

export interface Combination {
  selections: CombinationSelection[];
  combinedOdd: number | null;
  combinedProbability: number;
  highRisk?: boolean;
}

interface Props {
  combination: Combination | null;
  totalSelections: number;
  onRemove: (fixtureId: string | number, selection: CombinationSelection) => void;
  onClear: () => void;
  onSave?: (() => void) | null;
  saving?: boolean;
  savedCombinadas?: any[];
  onDeleteSaved?: ((id: string | number) => void) | null;
  bookmakerPrefix?: string;
}

/** Constructor de combinadas dentro de Favoritos: un mercado por partido. */
export function CombinationPanel({ combination, totalSelections, onRemove, onClear, onSave, saving, savedCombinadas = [], onDeleteSaved, bookmakerPrefix = '' }: Props) {
  return (
    <Card tone="accent" style={{ gap: 12 }}>
      <View style={styles.heading}>
        <View style={styles.headingIcon}><Layers size={18} color={colors.accent} /></View>
        <View style={{ flex: 1 }}>
          <AppText variant="kicker" tone="muted">Dentro de Favoritos</AppText>
          <AppText variant="heading">Tu combinada</AppText>
        </View>
        {totalSelections > 0 && <AppText variant="mono" tone="accent">{totalSelections}</AppText>}
      </View>

      {!combination || combination.selections.length === 0 ? (
        <View style={styles.empty}>
          <AppText variant="label" weight="bold">Combinada vacía</AppText>
          <AppText variant="caption" tone="muted">Elige un mercado por partido. Al escoger otro del mismo encuentro, sustituirá al anterior.</AppText>
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          {combination.selections.map((sel, index) => {
            const probability = Number(sel.rawProbability ?? sel.probability ?? 0);
            const probColor = probability >= 75 ? colors.accent : probability >= 50 ? colors.warning : colors.error;
            return (
              <View key={`${sel.fixtureId}-${sel.id || sel.marketKey}-${index}`} style={styles.item}>
                <AppText variant="mono" size={11} tone="faint">{String(index + 1).padStart(2, '0')}</AppText>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <AppText variant="caption" tone="muted">{sel.matchName}</AppText>
                  <AppText variant="label" weight="bold">{bookmakerPrefix}{displayBettingText(sel.name || sel.market || '')}</AppText>
                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    <AppText variant="caption" tone="muted">Prob. <AppText variant="mono" size={12} style={{ color: probColor }}>{cap(probability)}%</AppText></AppText>
                    <AppText variant="caption" tone="muted">Cuota <AppText variant="mono" size={12} style={{ color: colors.amber }}>{sel.odd ? Number(sel.odd).toFixed(2) : '—'}</AppText></AppText>
                  </View>
                </View>
                <Pressable onPress={() => onRemove(sel.fixtureId, sel)} hitSlop={8} accessibilityLabel={`Quitar ${sel.name || ''}`} style={styles.remove}><X size={14} color={colors.muted} /></Pressable>
              </View>
            );
          })}
          <View style={styles.summary}>
            <View style={styles.summaryRow}>
              <AppText variant="label" tone="secondary">Cuota total (x{combination.selections.length})</AppText>
              <AppText variant="mono" weight="bold" style={{ color: colors.amber }}>{combination.combinedOdd ? Number(combination.combinedOdd).toFixed(2) : '—'}</AppText>
            </View>
            <View style={styles.summaryRow}>
              <AppText variant="label" tone="secondary">Probabilidad compuesta</AppText>
              <AppText variant="mono" weight="bold" tone={combination.highRisk || combination.combinedProbability < 60 ? 'error' : 'accent'}>{cap(combination.combinedProbability)}%</AppText>
            </View>
            {(combination.highRisk || combination.combinedProbability < 60) && <AppText variant="caption" tone="warning">Combinada de alto riesgo (&lt;60%)</AppText>}
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {onSave && <Button title={saving ? 'Guardando…' : 'Guardar combinada'} onPress={onSave} loading={saving} icon={<Save size={15} color={colors.onAccent} />} style={{ flex: 1 }} />}
            <Button title="Limpiar" variant="ghost" onPress={onClear} icon={<Trash size={15} color={colors.textSecondary} />} style={{ flex: onSave ? undefined : 1 }} />
          </View>
        </View>
      )}

      {savedCombinadas.length > 0 && (
        <View style={{ gap: 8 }}>
          <AppText variant="kicker" tone="muted">Combinadas guardadas</AppText>
          {savedCombinadas.map((comb) => {
            const odd = comb.combined_odd ?? comb.combinedOdd;
            const probability = comb.combined_probability ?? comb.combinedProbability;
            return (
              <View key={comb.id} style={styles.saved}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <AppText variant="label" weight="bold" style={{ flex: 1 }} numberOfLines={1}>{comb.name}</AppText>
                  {onDeleteSaved && <Pressable onPress={() => onDeleteSaved(comb.id)} hitSlop={8} accessibilityLabel={`Eliminar ${comb.name}`}><X size={15} color={colors.muted} /></Pressable>}
                </View>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <AppText variant="caption" tone="muted">{(comb.selections || []).length} sel.</AppText>
                  <AppText variant="mono" size={12} style={{ color: colors.amber }}>{odd ?? '—'}x</AppText>
                  <AppText variant="mono" size={12} tone={Number(probability) >= 60 ? 'accent' : 'error'}>{cap(probability)}%</AppText>
                </View>
                {groupSavedCombinadaSelections(comb.selections).map((match: any) => (
                  <View key={match.key} style={styles.savedMatch}>
                    <AppText variant="caption" tone="muted">Partido · <AppText variant="caption" tone="secondary">{match.matchName}</AppText></AppText>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      {match.selections.map((selection: any, index: number) => (
                        <View key={`${selection.id || selection.market || 'sel'}-${index}`} style={styles.chip}>
                          <AppText variant="caption">{displayBettingText(selection.name || selection.market)} {selection.odd ? `(${Number(selection.odd).toFixed(2)})` : ''}</AppText>
                        </View>
                      ))}
                    </View>
                  </View>
                ))}
              </View>
            );
          })}
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  heading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headingIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
  empty: { gap: 4, padding: 12, borderRadius: radius.md, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: colors.border },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: radius.md, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: colors.border },
  remove: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.05)' },
  summary: { gap: 6, padding: 12, borderRadius: radius.md, backgroundColor: 'rgba(255,255,255,0.04)' },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  saved: { gap: 8, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.03)' },
  savedMatch: { gap: 6 },
  chip: { paddingVertical: 4, paddingHorizontal: 8, borderRadius: radius.pill, backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder },
});
