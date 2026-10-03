import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import * as Linking from 'expo-linking';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { CheckCircle2, MailCheck } from 'lucide-react-native';
import { AuthShell } from '@/components/AuthShell';
import { AppText, Banner, Button } from '@/components/ui';
import { authTokenFromLink } from '@/lib/auth-link';
import { useAuth } from '@/lib/auth-context';
import { colors } from '@/theme/tokens';

export default function VerifyEmailScreen() {
  const url = Linking.useURL();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = authTokenFromLink(url, params.token);
  const { verifyEmail } = useAuth();
  const router = useRouter();
  const attempted = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token || attempted.current === token) return;
    attempted.current = token;
    setLoading(true);
    setError('');
    verifyEmail(token)
      .then(() => {
        setVerified(true);
        setTimeout(() => router.replace('/dashboard'), 350);
      })
      .catch((cause: any) => setError(cause?.message || 'El enlace no es válido o expiró.'))
      .finally(() => setLoading(false));
  }, [router, token, verifyEmail]);

  const footer = (
    <View style={{ alignItems: 'center', marginTop: 6 }}>
      <Link href="/sign-in" asChild><Pressable><AppText tone="accent" weight="bold">Volver al inicio de sesión</AppText></Pressable></Link>
    </View>
  );

  return (
    <AuthShell
      eyebrow="Confirma tu cuenta"
      title={verified ? 'Correo verificado' : 'Revisa tu correo'}
      subtitle={token ? 'Estamos validando tu enlace seguro.' : 'Te enviamos un enlace para activar la cuenta. Ábrelo en este dispositivo desde tu correo.'}
      footer={footer}
    >
      <View style={{ alignItems: 'center', paddingVertical: 8 }}>
        {verified ? <CheckCircle2 size={46} color={colors.accent} /> : <MailCheck size={46} color={colors.accent} />}
      </View>
      {loading ? <Button title="Verificando…" loading disabled /> : null}
      {verified ? <Banner tone="success" message="Tu cuenta quedó activa. Entrando al panel…" /> : null}
      {error ? <Banner tone="error" message={error} /> : null}
    </AuthShell>
  );
}
