import { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { ArrowRight, CheckSquare2, LockKeyhole, Mail, Square, UserRound } from 'lucide-react-native';
import { AuthShell } from '@/components/AuthShell';
import { AppText, Banner, Button, Input } from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { ApiError } from '@/lib/api';
import { colors } from '@/theme/tokens';

export default function SignUpScreen() {
  const { signUp } = useAuth();
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [emailTaken, setEmailTaken] = useState(false);
  const [loading, setLoading] = useState(false);
  const [acceptedLegal, setAcceptedLegal] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);

  const submit = async () => {
    setError('');
    setEmailTaken(false);
    if (!name.trim() || !email.trim() || !password) { setError('Nombre, email y contraseña son obligatorios'); return; }
    if (password.length < 8) { setError('La contraseña debe tener al menos 8 caracteres'); return; }
    if (name.trim().length > 60) { setError('El nombre no puede superar 60 caracteres'); return; }
    if (!acceptedLegal) { setError('Debes aceptar los documentos legales para registrarte'); return; }
    setLoading(true);
    try {
      await signUp(name.trim(), email.trim(), password, marketingConsent);
      router.replace('/dashboard');
    } catch (cause: any) {
      setError(cause?.message || 'Error al registrarse. Intenta de nuevo.');
      setEmailTaken(cause instanceof ApiError && cause.status === 409);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      eyebrow="Crea tu cuenta"
      title="Empieza con ventaja"
      subtitle="Completa tus datos y empieza gratis. Sin tarjeta."
      footer={(
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 4, marginTop: 6 }}>
          <AppText tone="muted">¿Ya tienes una cuenta?</AppText>
          <Link href="/sign-in" asChild><Pressable><AppText tone="accent" weight="bold">Inicia sesión</AppText></Pressable></Link>
        </View>
      )}
    >
      <Input label="Nombre" icon={<UserRound size={18} color={colors.muted} />} value={name} onChangeText={setName} placeholder="Tu nombre" autoComplete="name" textContentType="name" maxLength={60} />
      <Input label="Correo electrónico" icon={<Mail size={18} color={colors.muted} />} value={email} onChangeText={setEmail} placeholder="tu@correo.com" keyboardType="email-address" autoCapitalize="none" autoComplete="email" textContentType="emailAddress" />
      <Input label="Contraseña" hint="Usa al menos 8 caracteres." icon={<LockKeyhole size={18} color={colors.muted} />} value={password} onChangeText={setPassword} placeholder="Mínimo 8 caracteres" secureTextEntry autoComplete="new-password" textContentType="newPassword" onSubmitEditing={submit} returnKeyType="go" />
      <Pressable onPress={() => setAcceptedLegal((value) => !value)} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
        {acceptedLegal ? <CheckSquare2 size={20} color={colors.accent} /> : <Square size={20} color={colors.muted} />}
        <AppText tone="muted" style={{ flex: 1 }}>Soy mayor de 18 años y acepto los documentos legales obligatorios.</AppText>
      </Pressable>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {['terminos', 'privacidad', 'cookies'].map((document) => (
          <Pressable key={document} onPress={() => Linking.openURL(`https://cfanalisis.com/${document}`)}>
            <AppText tone="accent" weight="bold">{document[0].toUpperCase() + document.slice(1)}</AppText>
          </Pressable>
        ))}
      </View>
      <Pressable onPress={() => setMarketingConsent((value) => !value)} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
        {marketingConsent ? <CheckSquare2 size={20} color={colors.accent} /> : <Square size={20} color={colors.muted} />}
        <AppText tone="muted" style={{ flex: 1 }}>Quiero recibir descuentos y novedades. Es opcional.</AppText>
      </Pressable>
      {error ? (
        <View style={{ gap: 6 }}>
          <Banner tone="error" message={error} />
          {emailTaken && <Link href="/sign-in" asChild><Pressable><AppText tone="accent" weight="bold" align="center">Inicia sesión para continuar</AppText></Pressable></Link>}
        </View>
      ) : null}
      <Button title={loading ? 'Creando cuenta…' : 'Continuar'} size="lg" loading={loading} onPress={submit} icon={<ArrowRight size={17} color={colors.onAccent} />} />
    </AuthShell>
  );
}
