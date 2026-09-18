import type { ReactElement } from 'react';

// Stripe es un módulo nativo que NO existe en Expo Go. Se carga de forma
// perezosa: en un development build real está disponible y se usa el
// PaymentSheet; en Expo Go `stripe` es null y el pago se abre en el navegador.
type StripeModule = typeof import('@stripe/stripe-react-native');

let stripeModule: StripeModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@stripe/stripe-react-native') as Partial<StripeModule> | undefined;
  if (typeof mod?.StripeProvider === 'function' && typeof mod?.useStripe === 'function') stripeModule = mod as StripeModule;
} catch {
  stripeModule = null;
}

export const stripeAvailable = !!stripeModule;

export function StripeProvider({ publishableKey, children }: { publishableKey: string; children: ReactElement }) {
  if (!stripeModule) return <>{children}</>;
  const Provider = stripeModule.StripeProvider;
  return <Provider publishableKey={publishableKey || 'pk_test_placeholder'} merchantIdentifier="merchant.com.cfanalisis.app" urlScheme="cfanalisis">{children}</Provider>;
}

/** Devuelve las funciones del PaymentSheet o null cuando Stripe no está disponible. */
export function useOptionalStripe(): ReturnType<StripeModule['useStripe']> | null {
  if (!stripeModule) return null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return stripeModule.useStripe();
}
