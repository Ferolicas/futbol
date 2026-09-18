import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Link } from 'expo-router';
import { Mail } from 'lucide-react-native';
import { AuthShell } from '@/components/AuthShell';
import { AppText, Banner, Button, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { colors } from '@/theme/tokens';

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!email.trim()) { setError('Email requerido'); return; }
    setError('');
    setLoading(true);
    try {
      await api.post('/api/auth/forgot-password', { email: email.trim() }, { allowUnauthorized: true });
      setSent(true);
    } catch (cause: any) {
      setError(cause?.message || 'Error de conexión. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  const back = (
    <View style={{ alignItems: 'center', marginTop: 6 }}>
      <Link href="/sign-in" asChild><Pressable><AppText tone="accent" weight="bold">Volver al inicio de sesión</AppText></Pressable></Link>
    </View>
  );

  if (sent) {
    return (
      <AuthShell eyebrow="Revisa tu correo" title="Enlace enviado" subtitle="Si tu email está registrado, recibirás un enlace para restablecer tu contraseña en los próximos minutos. El enlace abre la web de CF Análisis; después vuelve aquí e inicia sesión." footer={back}>
        <View />
      </AuthShell>
    );
  }

  return (
    <AuthShell eyebrow="Recuperar acceso" title="Restablecer contraseña" subtitle="Ingresa tu email y te enviaremos un enlace para crear una nueva contraseña." footer={back}>
      <Input label="Correo electrónico" icon={<Mail size={18} color={colors.muted} />} value={email} onChangeText={setEmail} placeholder="Introduce tu correo electrónico" keyboardType="email-address" autoCapitalize="none" autoComplete="email" onSubmitEditing={submit} returnKeyType="send" />
      {error ? <Banner tone="error" message={error} /> : null}
      <Button title={loading ? 'Enviando…' : 'Enviar enlace'} size="lg" loading={loading} onPress={submit} />
    </AuthShell>
  );
}
