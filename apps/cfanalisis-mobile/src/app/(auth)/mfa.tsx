import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { ShieldCheck } from 'lucide-react-native';
import { AuthShell } from '@/components/AuthShell';
import { AppText, Banner, Button, Input } from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { colors } from '@/theme/tokens';

export default function MfaScreen() {
  const { verifyMfa } = useAuth();
  const router = useRouter();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!/^\d{6}$/.test(code)) { setError('Introduce el código de 6 dígitos.'); return; }
    setError('');
    setLoading(true);
    try {
      await verifyMfa(code);
      router.replace('/dashboard');
    } catch (cause: any) {
      setError(cause?.message || 'Código inválido o expirado.');
    } finally { setLoading(false); }
  };

  return (
    <AuthShell
      eyebrow="Verificación en dos pasos"
      title="Código de seguridad"
      subtitle="Enviamos un código de seis dígitos al correo de la cuenta administrativa. Expira en 10 minutos."
      footer={<View style={{ alignItems: 'center' }}><Link href="/sign-in" asChild><Pressable><AppText tone="accent" weight="bold">Volver a iniciar sesión</AppText></Pressable></Link></View>}
    >
      <Input
        label="Código"
        icon={<ShieldCheck size={18} color={colors.muted} />}
        value={code}
        onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))}
        placeholder="000000"
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={6}
        onSubmitEditing={submit}
      />
      {error ? <Banner tone="error" message={error} /> : null}
      <Button title={loading ? 'Verificando…' : 'Verificar y entrar'} loading={loading} onPress={submit} disabled={code.length !== 6} />
    </AuthShell>
  );
}
