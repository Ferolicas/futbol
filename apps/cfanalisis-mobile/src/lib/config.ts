import Constants from 'expo-constants';

const extra = (Constants.expoConfig?.extra || {}) as Record<string, string | undefined>;

function trimSlash(value: string) {
  return value.replace(/\/+$/, '');
}

/** URL base de la API (la misma web Next.js que sirve cfanalisis.com). */
export const API_URL = trimSlash(process.env.EXPO_PUBLIC_API_URL || extra.apiUrl || 'https://cfanalisis.com');

/** Gateway WebSocket del worker realtime. */
export const WS_URL = process.env.EXPO_PUBLIC_WS_URL || extra.wsUrl || 'wss://worker.cfanalisis.com/ws';

export const STRIPE_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY || '';

/** Convierte una ruta relativa de la web (/Bet365-Logo.png) en URL absoluta. */
export function assetUrl(path: string | null | undefined) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_URL}${path.startsWith('/') ? '' : '/'}${path}`;
}
