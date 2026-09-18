import * as SecureStore from 'expo-secure-store';

// La web guarda la sesión en la cookie httpOnly `cf_session` (JWT HS256 de 30
// días). En móvil no hay navegador: capturamos ese mismo JWT del `Set-Cookie`
// que devuelve /api/auth/login o /api/register y lo enviamos como cabecera
// `Cookie` en cada petición. El backend no cambia.
const KEY = 'cf_session';
const COOKIE_NAME = 'cf_session';

let cached: string | null | undefined;

export async function getSessionToken(): Promise<string | null> {
  if (cached !== undefined) return cached;
  try {
    cached = (await SecureStore.getItemAsync(KEY)) || null;
  } catch {
    cached = null;
  }
  return cached;
}

export async function setSessionToken(token: string | null) {
  cached = token;
  try {
    if (token) await SecureStore.setItemAsync(KEY, token);
    else await SecureStore.deleteItemAsync(KEY);
  } catch {
    // SecureStore puede fallar en simuladores sin keychain; la sesión sigue en memoria.
  }
}

/** Extrae el valor de cf_session de una cabecera Set-Cookie (una o varias unidas por coma). */
export function parseSessionCookie(setCookie: string | null | undefined): string | null {
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`(?:^|[,;\\s])${COOKIE_NAME}=([^;,\\s]+)`));
  if (!match) return null;
  const value = match[1];
  // Un valor vacío es la orden de borrar la cookie (logout / sesión revocada).
  return value && value.length > 20 ? value : null;
}

export function sessionCookieHeader(token: string | null) {
  return token ? `${COOKIE_NAME}=${token}` : null;
}
