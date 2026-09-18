import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Eye, LockKeyhole, Sparkles, X } from 'lucide-react-native';
import { AppText, Button, Card, ProgressBar } from '@/components/ui';
import { MarketOutcomeBadge } from './MarketOutcomeBadge';
import { useAccess } from '@/lib/access-context';
import { api } from '@/lib/api';
import { colors, radius } from '@/theme/tokens';

const PLANS: Array<[string, string]> = [['semanal', 'Semanal'], ['mensual', 'Mensual'], ['trimestral', 'Trimestral'], ['semestral', 'Semestral'], ['anual', 'Anual']];
const pct = (value: unknown) => `${Math.floor(Number(value) * 100) / 100}%`;

export function UpgradeButton() {
  const { isFree, openPlans } = useAccess();
  if (!isFree) return null;
  return (
    <Pressable onPress={openPlans} style={({ pressed }) => [styles.upgrade, pressed && { opacity: 0.85 }]} accessibilityRole="button">
      <Sparkles size={14} color={colors.onAccent} />
      <AppText variant="label" weight="bold" size={12} style={{ color: colors.onAccent }}>Pro</AppText>
    </Pressable>
  );
}

export function LockedAnalysis({ title = 'Análisis completo' }: { title?: string }) {
  const { openPlans } = useAccess();
  return (
    <Card>
      <View style={{ gap: 6, marginBottom: 12 }}>
        {Array.from({ length: 5 }, (_, index) => (
          <View key={index} style={styles.placeholderRow}>
            <AppText variant="caption" tone="faint">Contenido exclusivo del análisis</AppText>
            <AppText variant="caption" tone="faint">•••</AppText>
          </View>
        ))}
      </View>
      <View style={{ alignItems: 'center', gap: 8 }}>
        <LockKeyhole size={22} color={colors.accent} />
        <AppText variant="heading">{title}</AppText>
        <Button title="Actualizar plan para ver" onPress={openPlans} />
      </View>
    </Card>
  );
}

interface FreeRecProps { preview: any; selected?: Record<string, unknown>; onToggle?: ((pick: any) => void) | null }

/** Una opción visible de 60–70% con cuota real; las Pro ocultas solo enseñan el porcentaje. */
export function FreeRecommendations({ preview, selected = {}, onToggle = null }: FreeRecProps) {
  const { openPlans } = useAccess();
  const pick = preview?.selection;
  const revealed: any[] = preview?.revealed || [];
  const isFinal = !!pick?.outcome || revealed.length > 0;
  const canSelect = !!pick?.id && !pick.outcome && typeof onToggle === 'function';
  const pickSelected = !!(pick?.id && selected?.[pick.id]);

  return (
    <View style={{ gap: 10 }}>
      <AppText variant="caption" tone="muted">{isFinal ? 'Partido finalizado · todas las opciones ya muestran su resultado oficial.' : 'Tu opción gratis · probabilidad de 60–70% con cuota real.'}</AppText>
      {!pick && <AppText variant="caption" tone="muted">{preview?.unavailable || 'La opción gratuita aparecerá cuando exista una probabilidad de 60–70% con cuota real.'}</AppText>}
      {pick && (
        <Pressable
          disabled={!canSelect}
          onPress={() => onToggle?.(pick)}
          accessibilityRole="button"
          accessibilityState={{ selected: pickSelected }}
          style={[styles.market, pickSelected && styles.marketSelected, pick.outcome?.status === 'won' && styles.won, pick.outcome?.status === 'lost' && styles.lost]}
        >
          <AppText variant="label" weight="bold">{pick.name}</AppText>
          <AppText variant="caption" tone="accent">{canSelect ? (pickSelected ? 'Añadida a tu combinada' : 'Toca para añadir a tu combinada') : 'Tu recomendación gratis'}</AppText>
          {pick.outcome && <MarketOutcomeBadge outcome={pick.outcome} pendingLabel="Pendiente oficial" compact />}
          <ProgressBar value={pick.probability} />
          <View style={styles.nums}>
            <AppText variant="mono" weight="bold" tone="accent">{pct(pick.probability)}</AppText>
            <AppText variant="mono" style={{ color: colors.amber }}>@{Number(pick.odd).toFixed(2)}</AppText>
            <AppText variant="caption" tone="muted">{pick.bookmaker}</AppText>
          </View>
        </Pressable>
      )}
      {(preview?.locked || []).map((item: any, index: number) => (
        <Pressable key={index} onPress={openPlans} style={styles.locked} accessibilityRole="button" accessibilityLabel={`Ver opción Pro con probabilidad ${pct(item.probability)}`}>
          <AppText variant="label" tone="faint">Recomendación exclusiva Pro</AppText>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Eye size={16} color={colors.accent} />
            <AppText variant="label" tone="accent">Ver</AppText>
          </View>
          <ProgressBar value={item.probability} color={colors.muted} />
          <AppText variant="mono" weight="bold">{pct(item.probability)}</AppText>
        </Pressable>
      ))}
      {revealed.map((item, index) => (
        <View key={`${item.name}-${index}`} style={[styles.market, item.outcome?.status === 'won' && styles.won, item.outcome?.status === 'lost' && styles.lost]}>
          <AppText variant="label" weight="bold">{item.name}</AppText>
          <AppText variant="caption" tone="muted">Opción Pro revelada</AppText>
          <MarketOutcomeBadge outcome={item.outcome} pendingLabel="Pendiente oficial" compact />
          <ProgressBar value={item.probability} />
          <View style={styles.nums}>
            <AppText variant="mono" weight="bold" tone="accent">{pct(item.probability)}</AppText>
            <AppText variant="mono" style={{ color: colors.amber }}>@{Number(item.odd).toFixed(2)}</AppText>
            <AppText variant="caption" tone="muted">{item.bookmaker}</AppText>
          </View>
        </View>
      ))}
    </View>
  );
}

/** Selector de planes que aparece en las visitas 1, 4, 7… de una cuenta Gratis. */
export function PlansModal() {
  const { isFree, plansOpen, closePlans } = useAccess();
  const router = useRouter();
  const [prices, setPrices] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    if (!plansOpen) return;
    let active = true;
    api.get<{ countryCode?: string }>('/api/detect-country')
      .then((geo) => api.get<{ plans: Record<string, any> }>(`/api/currency?country=${encodeURIComponent(geo.countryCode || 'US')}`))
      .then((data) => { if (active) setPrices(data.plans); })
      .catch(() => {});
    return () => { active = false; };
  }, [plansOpen]);

  if (!isFree) return null;
  return (
    <Modal visible={plansOpen} transparent animationType="fade" onRequestClose={closePlans}>
      <View style={styles.overlay}>
        <View style={styles.dialog}>
          <Pressable onPress={closePlans} style={styles.close} hitSlop={10} accessibilityLabel="Cerrar selector de planes"><X size={20} color={colors.muted} /></Pressable>
          <Sparkles size={30} color={colors.accent} />
          <AppText variant="kicker" tone="accent">CF Análisis Pro</AppText>
          <AppText variant="title" align="center">Todas las opciones. Todo el análisis.</AppText>
          <AppText tone="muted" align="center">Elige tu plan para desbloquear las recomendaciones, las frecuencias y el veredicto en los cuatro deportes.</AppText>
          <ScrollView style={{ maxHeight: 300, alignSelf: 'stretch' }} contentContainerStyle={{ gap: 8 }}>
            {PLANS.map(([id, name]) => {
              const plan = prices?.[id];
              let amount: string | null = null;
              if (plan) {
                try {
                  amount = new Intl.NumberFormat('es', { style: 'currency', currency: plan.fixedCurrency ? plan.nativeCurrency : plan.currency || 'USD' }).format(plan.fixedCurrency ? plan.nativeAmount : plan.local ?? plan.nativeAmount ?? plan.usd);
                } catch { amount = `${plan.local ?? plan.nativeAmount} ${plan.currency}`; }
              }
              return (
                <Pressable key={id} onPress={() => { closePlans(); router.push({ pathname: '/plans', params: { checkout: id } }); }} style={({ pressed }) => [styles.planRow, pressed && { opacity: 0.85 }]}>
                  <AppText variant="label" weight="bold">{name}</AppText>
                  <AppText variant="label" tone="accent">{amount || 'Ver precio'} →</AppText>
                </Pressable>
              );
            })}
          </ScrollView>
          <Button title="Continuar gratis" variant="ghost" onPress={closePlans} style={{ alignSelf: 'stretch' }} />
          <AppText variant="caption" tone="muted" align="center">Gratis: una opción calculada de 60–70% con cuota real por evento cuando exista. Sin tarjeta.</AppText>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  upgrade: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: radius.pill, backgroundColor: colors.accent },
  placeholderRow: { flexDirection: 'row', justifyContent: 'space-between', padding: 10, borderRadius: radius.sm, backgroundColor: 'rgba(255,255,255,0.03)' },
  market: { gap: 6, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.accentBorder, backgroundColor: 'rgba(94,230,177,0.05)' },
  marketSelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  won: { borderColor: colors.accent },
  lost: { borderColor: 'rgba(251,113,133,0.5)' },
  locked: { gap: 6, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.03)' },
  nums: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  dialog: { width: '100%', maxWidth: 420, gap: 12, alignItems: 'center', padding: 22, borderRadius: 22, backgroundColor: colors.surfaceSolid, borderWidth: 1, borderColor: colors.accentBorder },
  close: { position: 'absolute', top: 12, right: 12, zIndex: 1 },
  planRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.03)' },
});
