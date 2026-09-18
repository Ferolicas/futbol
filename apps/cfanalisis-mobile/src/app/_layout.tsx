import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts, PlusJakartaSans_500Medium, PlusJakartaSans_600SemiBold, PlusJakartaSans_700Bold, PlusJakartaSans_800ExtraBold } from '@expo-google-fonts/plus-jakarta-sans';
import { JetBrainsMono_600SemiBold, JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StripeProvider } from '@/lib/stripe';
import { SWRConfig } from 'swr';
import { AppState, type AppStateStatus } from 'react-native';
import { AuthProvider } from '@/lib/auth-context';
import { AccessProvider } from '@/lib/access-context';
import { SelectedMarketsProvider } from '@/lib/selected-markets';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/config';
import { colors } from '@/theme/tokens';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    PlusJakartaSans_500Medium, PlusJakartaSans_600SemiBold, PlusJakartaSans_700Bold, PlusJakartaSans_800ExtraBold,
    JetBrainsMono_600SemiBold, JetBrainsMono_700Bold,
  });

  useEffect(() => { if (fontsLoaded) SplashScreen.hideAsync().catch(() => {}); }, [fontsLoaded]);
  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        <StripeProvider publishableKey={STRIPE_PUBLISHABLE_KEY}>
          <SWRConfig value={{
            provider: () => new Map(),
            isVisible: () => AppState.currentState === 'active',
            initFocus: (callback) => {
              const sub = AppState.addEventListener('change', (state: AppStateStatus) => { if (state === 'active') callback(); });
              return () => sub.remove();
            },
          }}>
            <AuthProvider>
              <AccessProvider>
                <SelectedMarketsProvider>
                  <StatusBar style="light" />
                  <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'fade' }} />
                </SelectedMarketsProvider>
              </AccessProvider>
            </AuthProvider>
          </SWRConfig>
        </StripeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
