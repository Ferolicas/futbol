import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useStripe } from '@stripe/stripe-react-native';
import { Check, ChevronLeft, Globe, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react-native';
import { AppText, Banner, Button, Card, Screen } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { API_URL, STRIPE_PUBLISHABLE_KEY } from '@/lib/config';
import { useAccess } from '@/lib/access-context';
import { randomUUID } from '@/lib/format';
import { colors, radius } from '@/theme/tokens';

// Mismos IDs, orden y etiquetas que app/planes/planes-client.js. El precio y la
// moneda siempre los calcula el servidor (/api/currency y /api/checkout).
const PLAN_ORDER = [
  { id: 'semanal', name: 'Semanal', duration: '7 días', badge: null, perLabel: '/ semana', cycle: 'cada 7 días' },
  { id: 'mensual', name: 'Mensual', duration: '1 mes', badge: 'Popular', perLabel: '/ mes', cycle: 'cada mes' },
  { id: 'trimestral', name: 'Trimestral', duration: '3 meses', badge: null, perLabel: '/ 3 meses', cycle: 'cada 3 meses' },
  { id: 'semestral', name: 'Semestral', duration: '6 meses', badge: 'Mejor precio', perLabel: '/ 6 meses', cycle: 'cada 6 meses' },
  { id: 'anual', name: 'Anual', duration: '12 meses', badge: 'VIP', perLabel: '/ año', cycle: 'cada 12 meses' },
] as const;
const FEATURES = ['Análisis estadístico completo', 'Apuesta del día inteligente', 'Combinadas automáticas', 'Marcadores en vivo', '15+ ligas internacionales', 'Corners, tarjetas y BTTS'];
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);

function formatProviderAmount(amount: unknown, currency: unknown, fallback: string) {
  const code = String(currency || '').toUpperCase();
  if (!Number.isFinite(Number(amount)) || !/^[A-Z]{3}$/.test(code)) return fallback;
  const value = Number(amount) / (ZERO_DECIMAL.has(code) ? 1 : 100);
  try { return new Intl.NumberFormat('es', { style: 'currency', currency: code }).format(value); } catch { return `${value} ${code}`; }
}

export default function PlansScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ checkout?: string }>();
  const { isFree, refreshAccess } = useAccess();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const [prices, setPrices] = useState<any>(null);
  const [country, setCountry] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(params.checkout || null);
  const [error, setError] = useState('');
  const attempts = useRef(new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const geo = await api.get<{ countryCode?: string; currency?: string }>('/api/detect-country');
        const detected = geo.countryCode || null;
        const query = detected ? `country=${encodeURIComponent(detected)}` : `currency=${encodeURIComponent(geo.currency || 'USD')}`;
        const resolved = await api.get<any>(`/api/currency?${query}`);
        if (!cancelled) { setCountry(detected); setPrices(resolved); }
      } catch {
        if (!cancelled) setError('No pudimos detectar el precio para tu ubicación. Vuelve a intentarlo.');
      } finally { if (!cancelled) setReady(true); }
    })();
    return () => { cancelled = true; };
  }, []);

  const fmtPrice = useCallback((planId: string) => {
    if (!ready) return '...';
    const p = prices?.plans?.[planId];
    if (!p) return '—';
    if (p.fixedCurrency) return `${p.nativeAmount} ${p.nativeCurrency}`;
    if (!p.local || !p.currency || p.currency === 'USD') return `$${p.nativeAmount ?? p.usd} USD`;
    try { return new Intl.NumberFormat('es', { style: 'currency', currency: p.currency, maximumFractionDigits: 0 }).format(p.local); } catch { return `${Math.round(p.local)} ${p.currency}`; }
  }, [prices, ready]);

  const attemptFor = (provider: string, planId: string) => {
    const key = `${provider}:${planId}`;
    let id = attempts.current.get(key);
    if (!id) { id = randomUUID(); attempts.current.set(key, id); }
    return { key, id };
  };
  const discardAttempt = (key: string, attemptId: string) => {
    attempts.current.delete(key);
    api.delete(`/api/payments/attempt?attempt=${encodeURIComponent(attemptId)}`).catch(() => {});
  };

  const checkout = async (planId: string) => {
    if (loading || !ready) return;
    setSelected(planId);
    setError('');
    const planPrice = prices?.plans?.[planId];
    if (!planPrice) { setError('No se pudo calcular el precio para tu ubicación.'); return; }

    // Colombia → Mercado Pago. El Brick de MP es web: abrimos el checkout de la
    // web en el navegador del sistema (no WebView) con el mismo plan e intención.
    if (country === 'CO') {
      const intent = randomUUID();
      const url = `${API_URL}/planes?checkout=${encodeURIComponent(planId)}&intent=${encodeURIComponent(intent)}`;
      try { await Linking.openURL(url); } catch { setError('No se pudo abrir el pago. Visita cfanalisis.com/planes.'); }
      return;
    }

    if (!STRIPE_PUBLISHABLE_KEY) { setError('Falta configurar EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY en la app.'); return; }
    setLoading(true);
    const attempt = attemptFor('stripe', planId);
    try {
      const data = await api.post<any>('/api/checkout', { plan: planId, attemptId: attempt.id, country, currency: prices?.currency || 'EUR' });
      if (data.attemptId && data.attemptId !== attempt.id) attempts.current.set(attempt.key, data.attemptId);
      if (data.active) { router.replace({ pathname: '/payment-status', params: { attempt: data.attemptId || attempt.id } }); return; }
      if (!data.clientSecret) throw new Error(data.error || 'Error al procesar el pago');
      const displayAmount = formatProviderAmount(data.amount, data.currency, fmtPrice(planId));
      const init = await initPaymentSheet({
        paymentIntentClientSecret: data.clientSecret,
        merchantDisplayName: 'CF Análisis',
        returnURL: 'cfanalisis://payment-status',
        style: 'alwaysDark',
        appearance: { colors: { primary: colors.accent, background: colors.surfaceSolid, componentBackground: '#0b1720', componentText: colors.text, primaryText: colors.text, secondaryText: colors.muted, placeholderText: colors.faint, icon: colors.textSecondary } },
        applePay: { merchantCountryCode: country || 'ES' },
        googlePay: { merchantCountryCode: country || 'ES', currencyCode: String(data.currency || 'eur').toUpperCase() },
      });
      if (init.error) throw new Error(init.error.message);
      const result = await presentPaymentSheet();
      if (result.error) {
        if (result.error.code === 'Canceled') { discardAttempt(attempt.key, data.attemptId || attempt.id); setSelected(null); return; }
        throw new Error(result.error.message);
      }
      setError('');
      router.replace({ pathname: '/payment-status', params: { attempt: data.attemptId || attempt.id, amount: displayAmount } });
    } catch (cause: any) {
      const info = cause instanceof ApiError ? (cause.info as any) : null;
      if (info?.code === 'PAYMENT_IN_PROGRESS' && info.attemptId) { router.replace({ pathname: '/payment-status', params: { attempt: info.attemptId } }); return; }
      if (info?.code === 'ALREADY_ACTIVE') { await refreshAccess(); setError('Tu cuenta ya tiene un plan activo.'); return; }
      if (info?.code === 'USE_MERCADOPAGO') { setCountry('CO'); setError('En Colombia el pago se procesa con Mercado Pago. Vuelve a elegir el plan.'); return; }
      if (info?.code === 'ATTEMPT_EXPIRED') attempts.current.delete(attempt.key);
      setError(cause?.message || 'No pudimos iniciar el pago. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <View style={styles.topbar}>
        <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/dashboard'))} style={styles.back}><ChevronLeft size={18} color={colors.text} /><AppText variant="label">Volver</AppText></Pressable>
        <AppText variant="kicker" tone="muted">Planes</AppText>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Sparkles size={14} color={colors.accent} /><AppText variant="kicker" tone="accent">Activa tu ventaja</AppText></View>
          <AppText variant="title">Elige cómo quieres entrar</AppText>
          <AppText tone="muted">Todos los planes incluyen la plataforma completa. Solo cambia el periodo.</AppText>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Globe size={14} color={ready ? colors.accent : colors.muted} />
            <AppText variant="caption" tone="secondary">{ready ? `Precio en ${prices?.currency || 'USD'} · Pago con ${country === 'CO' ? 'Mercado Pago' : 'Stripe'}` : 'Detectando país y moneda…'}</AppText>
          </View>
        </View>
        {!isFree && <Banner tone="success" message="Tu cuenta ya tiene acceso Pro activo." />}
        {error ? <Banner tone="error" message={error} onClose={() => setError('')} /> : null}

        {PLAN_ORDER.map((plan) => {
          const original = prices?.plans?.[plan.id]?.originalAmount;
          const isSelected = selected === plan.id;
          const premium = plan.badge === 'VIP';
          return (
            <Card key={plan.id} tone={premium ? 'accent' : 'default'} style={[{ gap: 10 }, isSelected && { borderColor: colors.accent }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View>
                  <AppText variant="caption" tone="muted">{plan.duration}</AppText>
                  <AppText variant="heading">Plan {plan.name}</AppText>
                </View>
                {plan.badge && <View style={[styles.badge, premium && { backgroundColor: colors.amber }]}><AppText variant="kicker" size={9.5} style={{ color: colors.onAccent }}>{plan.badge}</AppText></View>}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6 }}>
                {original && <AppText variant="caption" tone="faint" style={{ textDecorationLine: 'line-through' }}>€{original}</AppText>}
                <AppText variant="mono" weight="bold" size={24} tone="accent">{fmtPrice(plan.id)}</AppText>
                <AppText variant="caption" tone="muted">{plan.perLabel}</AppText>
              </View>
              <AppText variant="caption" tone="muted">Cobro automático {plan.cycle} · Cancela cuando quieras</AppText>
              <View style={{ gap: 4 }}>
                {FEATURES.map((feature) => (
                  <View key={feature} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Check size={13} color={colors.accent} /><AppText variant="caption" tone="secondary">{feature}</AppText></View>
                ))}
              </View>
              <Button title={loading && isSelected ? 'Preparando pago…' : `Elegir Plan ${plan.name}`} loading={loading && isSelected} disabled={!ready || loading || !isFree} onPress={() => checkout(plan.id)} />
            </Card>
          );
        })}

        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><ShieldCheck size={14} color={colors.muted} /><AppText variant="caption" tone="muted">Pago protegido</AppText></View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><LockKeyhole size={14} color={colors.muted} /><AppText variant="caption" tone="muted">Datos cifrados</AppText></View>
        </View>
        <AppText variant="caption" tone="faint" align="center">El precio, la moneda y el proveedor los decide el servidor; la app nunca envía importes.</AppText>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  back: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: colors.border },
  badge: { paddingVertical: 4, paddingHorizontal: 9, borderRadius: radius.pill, backgroundColor: colors.accent },
});
