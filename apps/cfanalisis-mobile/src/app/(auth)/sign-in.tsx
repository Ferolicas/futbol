import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { ArrowRight, LockKeyhole, Mail } from 'lucide-react-native';
import { AuthShell } from '@/components/AuthShell';
import { AppText, Banner, Button, Input } from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { ApiError } from '@/lib/api';
import { colors } from '@/theme/tokens';

export default function SignInScreen() {
  const { signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!email.trim() || !password) { setError('Email y contraseña requeridos'); return; }
    setError('');
    setLoading(true);
    try {
      await signIn(email.trim(), password);
      router.replace('/dashboard');
    } catch (cause: any) {
      const info = cause instanceof ApiError ? (cause.info as any) : null;
      if (info?.needsReset) setError('Tu cuenta fue migrada. Usa "¿Olvidaste tu contraseña?" para crear una nueva.');
      else setError(cause?.message || 'Email o contraseña incorrectos');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      eyebrow="Acceso seguro"
      title="Bienvenido de vuelta"
      subtitle="Inicia sesión para volver a tu panel de análisis."
      footer={(
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 4, marginTop: 6 }}>
          <AppText tone="muted">¿Todavía no tienes cuenta?</AppText>
          <Link href="/sign-up" asChild><Pressable><AppText tone="accent" weight="bold">Regístrate</AppText></Pressable></Link>
        </View>
      )}
    >
      <Input label="Correo electrónico" icon={<Mail size={18} color={colors.muted} />} value={email} onChangeText={setEmail} placeholder="tu@correo.com" keyboardType="email-address" autoCapitalize="none" autoComplete="email" textContentType="emailAddress" />
      <View style={{ gap: 6 }}>
        <Input label="Contraseña" icon={<LockKeyhole size={18} color={colors.muted} />} value={password} onChangeText={setPassword} placeholder="Introduce tu contraseña" secureTextEntry autoComplete="password" textContentType="password" onSubmitEditing={submit} returnKeyType="go" />
        <Link href="/forgot-password" asChild><Pressable style={{ alignSelf: 'flex-end' }}><AppText variant="caption" tone="accent">¿La olvidaste?</AppText></Pressable></Link>
      </View>
      {error ? <Banner tone="error" message={error} /> : null}
      <Button title={loading ? 'Iniciando sesión…' : 'Entrar a mi cuenta'} size="lg" loading={loading} onPress={submit} icon={<ArrowRight size={17} color={colors.onAccent} />} />
    </AuthShell>
  );
}
