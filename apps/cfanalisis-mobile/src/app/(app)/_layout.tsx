import { Redirect, Stack } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '@/lib/auth-context';
import { useRealtimeLifecycle } from '@/lib/realtime/hooks';
import { PlansModal } from '@/components/analysis/FreeAccess';
import { colors } from '@/theme/tokens';

export default function AppLayout() {
  const { user, loading } = useAuth();
  useRealtimeLifecycle();
  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.accent} /></View>;
  if (!user) return <Redirect href="/sign-in" />;
  return (
    <>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="dashboard" />
        <Stack.Screen name="match/[sport]/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="search" options={{ presentation: 'modal', animation: 'fade' }} />
        <Stack.Screen name="chat" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="plans" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="payment-status" options={{ animation: 'fade' }} />
      </Stack>
      <PlansModal />
    </>
  );
}
