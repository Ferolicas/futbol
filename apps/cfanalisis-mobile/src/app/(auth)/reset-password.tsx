import { useState } from 'react';
import { Pressable, View } from 'react-native';
import * as Linking from 'expo-linking';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { KeyRound } from 'lucide-react-native';
import { AuthShell } from '@/components/AuthShell';
import { AppText, Banner, Button, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { authTokenFromLink } from '@/lib/auth-link';
import { useAuth } from '@/lib/auth-context';
import { colors } from '@/theme/tokens';

export default function ResetPasswordScreen() {
  const url = Linking.useURL();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = authTokenFromLink(url, params.token);
  const router = useRouter();
  const { clearLocalSession } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!token) { setError('El enlace no es válido o expiró. Solicita uno nuevo.'); return; }
    if (password.length < 8) { setError('La contraseña debe tener al menos 8 caracteres.'); return; }
    if (password !== confirmPassword) { setError('Las contraseñas no coinciden.'); return; }
    setError('');
    setLoading(true);
    try {
      await api.post('/api/auth/reset-password', { token, password, confirmPassword }, { allowUnauthorized: true });
      await clearLocalSession();
      setSuccess(true);
    } catch (cause: any) {
      setError(cause?.message || 'No se pudo restablecer la contraseña.');
    } finally { setLoading(false); }
  };

  const footer = (
    <View style={{ alignItems: 'center' }}>
      <Link href="/forgot-password" asChild><Pressable><AppText tone="accent" weight="bold">Solicitar otro enlace</AppText></Pressable></Link>
    </View>
  );

  if (success) {
    return (
      <AuthShell eyebrow="Acceso protegido" title="Contraseña actualizada" subtitle="Cerramos las sesiones anteriores para proteger tu cuenta." footer={footer}>
        <Banner tone="success" message="Ya puedes entrar con tu nueva contraseña." />
        <Button title="Iniciar sesión" onPress={() => router.replace('/sign-in')} />
      </AuthShell>
    );
  }

  return (
    <AuthShell eyebrow="Enlace seguro" title="Crea una contraseña nueva" subtitle="El enlace solo funciona una vez y expira en una hora." footer={footer}>
      <Input label="Nueva contraseña" icon={<KeyRound size={18} color={colors.muted} />} value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" placeholder="Mínimo 8 caracteres" maxLength={256} />
      <Input label="Confirmar contraseña" icon={<KeyRound size={18} color={colors.muted} />} value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" placeholder="Repite la contraseña" maxLength={256} onSubmitEditing={submit} />
      {error ? <Banner tone="error" message={error} /> : null}
      <Button title={loading ? 'Actualizando…' : 'Guardar contraseña'} loading={loading} onPress={submit} disabled={!token || !password || !confirmPassword} />
    </AuthShell>
  );
}
