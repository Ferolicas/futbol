import * as SecureStore from 'expo-secure-store';
import { API_URL } from './config';

const SESSION_KEY = 'cfanalisis.session.v2';
const MFA_KEY = 'cfanalisis.mfa.v1';
const LEGACY_SESSION_KEY = 'cf_session';
const isProductionApi = API_URL === 'https://cfanalisis.com';

const COOKIE_NAMES = {
  session: isProductionApi ? '__Host-cf_session' : 'cf_session_dev',
  mfa: isProductionApi ? '__Host-cf_mfa' : 'cf_mfa_dev',
} as const;

const STORAGE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

type AuthTokens = { session: string | null; mfa: string | null };
type CookieChanges = { session?: string | null; mfa?: string | null };
let cached: AuthTokens | undefined;

async function loadTokens(): Promise<AuthTokens> {
  if (cached) return cached;
  try {
    const [session, mfa, legacy] = await Promise.all([
      SecureStore.getItemAsync(SESSION_KEY, STORAGE_OPTIONS),
      SecureStore.getItemAsync(MFA_KEY, STORAGE_OPTIONS),
      SecureStore.getItemAsync(LEGACY_SESSION_KEY, STORAGE_OPTIONS),
    ]);
    const migratedSession = session || legacy || null;
    cached = { session: migratedSession, mfa: mfa || null };
    if (!session && legacy) await SecureStore.setItemAsync(SESSION_KEY, legacy, STORAGE_OPTIONS);
    if (legacy) await SecureStore.deleteItemAsync(LEGACY_SESSION_KEY, STORAGE_OPTIONS);
  } catch {
    cached = { session: null, mfa: null };
  }
  return cached;
}

async function persist(key: string, value: string | null) {
  try {
    if (value) await SecureStore.setItemAsync(key, value, STORAGE_OPTIONS);
    else await SecureStore.deleteItemAsync(key, STORAGE_OPTIONS);
  } catch {
    // En simuladores sin keychain la sesión queda solo en memoria.
  }
}

export async function getSessionToken() {
  return (await loadTokens()).session;
}

export async function clearAuthTokens() {
  cached = { session: null, mfa: null };
  await Promise.all([
    persist(SESSION_KEY, null),
    persist(MFA_KEY, null),
    persist(LEGACY_SESSION_KEY, null),
  ]);
}

function cookieValue(header: string, name: string): string | null | undefined {
  const match = header.match(new RegExp(`(?:^|[,;\\s])${name}=([^;,\\s]*)`));
  if (!match) return undefined;
  const value = match[1] || '';
  return value.length > 20 ? value : null;
}

/** Distingue entre cookie ausente (undefined) y cookie borrada (null). */
export function parseAuthCookies(setCookie: string | null | undefined): CookieChanges {
  if (!setCookie) return {};
  return {
    session: cookieValue(setCookie, COOKIE_NAMES.session),
    mfa: cookieValue(setCookie, COOKIE_NAMES.mfa),
  };
}

export async function applyAuthCookies(changes: CookieChanges) {
  const tokens = await loadTokens();
  const next = {
    session: changes.session === undefined ? tokens.session : changes.session,
    mfa: changes.mfa === undefined ? tokens.mfa : changes.mfa,
  };
  cached = next;
  await Promise.all([
    changes.session === undefined ? Promise.resolve() : persist(SESSION_KEY, next.session),
    changes.mfa === undefined ? Promise.resolve() : persist(MFA_KEY, next.mfa),
  ]);
}

export async function authCookieHeader() {
  const tokens = await loadTokens();
  const values: string[] = [];
  if (tokens.session) values.push(`${COOKIE_NAMES.session}=${tokens.session}`);
  if (tokens.mfa) values.push(`${COOKIE_NAMES.mfa}=${tokens.mfa}`);
  return values.length ? values.join('; ') : null;
}
