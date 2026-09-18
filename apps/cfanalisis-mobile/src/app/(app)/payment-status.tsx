import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CircleCheck, Clock3, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react-native';
import { AppText, Button, Card, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { useAccess } from '@/lib/access-context';
import { useAuth } from '@/lib/auth-context';
import { colors } from '@/theme/tokens';

/** Confirmación durable del pago: relee /api/payments/status sin volver a cobrar. */
export default function PaymentStatusScreen() {
  const router = useRouter();
  const { attempt } = useLocalSearchParams<{ attempt?: string }>();
  const { refreshAccess } = useAccess();
  const { refreshSession } = useAuth();
  const [result, setResult] = useState<any>({ status: 'pending', message: 'Confirmando tu pago…' });
  const [checking, setChecking] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const stopped = useRef(false);
  const startedAt = useRef(Date.now());

  const check = useCallback(async () => {
    if (stopped.current || !attempt) return;
    setChecking(true);
    try {
      const data = await api.get<any>(`/api/payments/status?attempt=${encodeURIComponent(attempt)}`);
      setResult(data);
      if (data.status === 'succeeded') {
        stopped.current = true;
        await Promise.all([refreshAccess(), refreshSession()]);
        setTimeout(() => router.replace('/dashboard'), 900);
      } else if (data.status === 'failed') stopped.current = true;
    } catch {
      setResult({ status: 'pending', verificationDelayed: true, message: 'El proveedor está tardando en responder. Tu operación sigue guardada y puedes volver a comprobarla.' });
    } finally { setChecking(false); }
  }, [attempt, refreshAccess, refreshSession, router]);

  useEffect(() => {
    stopped.current = false;
    check();
    const timer = setInterval(() => {
      if (stopped.current) return;
      const elapsed = Date.now() - startedAt.current;
      if (elapsed <= 90_000 || elapsed % 10_000 < 2_500) check();
    }, 2_500);
    return () => { stopped.current = true; clearInterval(timer); };
  }, [check]);

  const cancelAttempt = async () => {
    if (cancelling || stopped.current || !attempt) return;
    setCancelling(true);
    try {
      await api.delete(`/api/payments/attempt?attempt=${encodeURIComponent(attempt)}`);
      stopped.current = true;
      router.replace('/plans');
    } catch (cause: any) {
      setResult((current: any) => ({ ...current, message: cause?.message || 'No se pudo cancelar todavía. Comprueba el estado antes de abrir otro pago.' }));
    } finally { setCancelling(false); }
  };

  const success = result.status === 'succeeded';
  const failed = result.status === 'failed';
  const Icon = success ? CircleCheck : failed ? TriangleAlert : Clock3;
  return (
    <Screen edges={['top', 'bottom']}>
      <View style={{ flex: 1, justifyContent: 'center', padding: 20 }}>
        <Card tone={success ? 'accent' : failed ? 'error' : 'default'} style={{ alignItems: 'center', gap: 12, padding: 24 }}>
          <Icon size={38} color={success ? colors.accent : failed ? colors.error : colors.warning} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><ShieldCheck size={13} color={colors.muted} /><AppText variant="kicker" tone="muted">Verificación segura</AppText></View>
          <AppText variant="title" align="center">{success ? 'Pago confirmado' : failed ? 'El pago no fue aprobado' : 'Estamos confirmando tu pago'}</AppText>
          <AppText tone="muted" align="center">{result.message || (success ? 'Tu acceso ya está activo.' : 'Consultando directamente con el proveedor…')}</AppText>
          {success && <AppText variant="caption" tone="accent">Entrando a CF Análisis…</AppText>}
          {!success && !failed && (
            <View style={{ gap: 8, alignSelf: 'stretch' }}>
              <Button title={checking ? 'Comprobando…' : 'Comprobar ahora'} onPress={check} disabled={checking || cancelling} icon={<RefreshCw size={15} color={colors.onAccent} />} />
              <Button title={cancelling ? 'Cancelando de forma segura…' : 'Cancelar este intento y usar otro método'} variant="ghost" onPress={cancelAttempt} disabled={checking || cancelling} />
            </View>
          )}
          {failed && <Button title="Volver a intentar" onPress={() => router.replace('/plans')} style={{ alignSelf: 'stretch' }} />}
          <AppText variant="caption" tone="faint" align="center">No cierres esta pantalla durante una autorización bancaria. Nunca debes pagar dos veces.</AppText>
        </Card>
      </View>
    </Screen>
  );
}
