import { Redirect, Stack, usePathname } from 'expo-router';
import { useAuth } from '@/lib/auth-context';
import { colors } from '@/theme/tokens';

export default function AuthLayout() {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  // Un usuario con sesión también debe poder consumir el enlace de cambio de
  // contraseña; el reset revocará todas sus sesiones al terminar.
  if (!loading && user && pathname !== '/reset-password') return <Redirect href="/dashboard" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
