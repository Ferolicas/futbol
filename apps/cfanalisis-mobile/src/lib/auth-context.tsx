import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, onUnauthorized } from './api';
import { clearAuthTokens, getSessionToken } from './session';
import { getUserTz } from './timezone';
import { LEGAL_DOCUMENT_VERSION } from './legal';

export interface SessionUser {
  id: string;
  email: string;
  emailVerified?: boolean;
  name?: string | null;
  role?: 'user' | 'admin' | 'owner' | string;
  plan?: string | null;
  subscription_status?: string | null;
  timezone?: string | null;
  custom_league_ids?: number[] | null;
  legalAcceptanceRequired?: boolean;
  legalDocumentVersion?: string;
  legalAcceptedAt?: string | null;
}

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  refreshSession: () => Promise<SessionUser | null>;
  signIn: (email: string, password: string) => Promise<{ mfaRequired: boolean; user: SessionUser | null }>;
  signUp: (name: string, email: string, password: string, marketingConsent?: boolean) => Promise<void>;
  verifyMfa: (code: string) => Promise<SessionUser>;
  verifyEmail: (token: string) => Promise<SessionUser>;
  clearLocalSession: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const tzSyncedRef = useRef<string | null>(null);

  // Misma llamada que el AuthProvider web: /api/auth/session devuelve user+perfil.
  const refreshSession = useCallback(async () => {
    try {
      const token = await getSessionToken();
      if (!token) { setUser(null); return null; }
      const data = await api.get<{ user: SessionUser | null }>('/api/auth/session', { allowUnauthorized: true });
      const next = data?.user ?? null;
      if (!next) await clearAuthTokens();
      setUser(next);
      return next;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refreshSession(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => onUnauthorized(() => {
    clearAuthTokens();
    setUser(null);
  }), []);

  // Igual que TimezoneSync en la web: guarda la zona horaria detectada una vez por sesión.
  useEffect(() => {
    if (!user) return;
    const tz = getUserTz();
    if (!tz || tzSyncedRef.current === tz) return;
    api.put('/api/user/timezone', { timezone: tz })
      .then(() => { tzSyncedRef.current = tz; })
      .catch(() => {});
  }, [user]);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await api.post<{ mfaRequired?: boolean }>('/api/auth/login', { email, password }, { allowUnauthorized: true });
    if (result?.mfaRequired) return { mfaRequired: true, user: null };
    const token = await getSessionToken();
    if (!token) throw new Error('No recibimos la sesión del servidor. Intenta de nuevo.');
    const next = await refreshSession();
    if (!next) throw new Error('No se pudo iniciar la sesión.');
    return { mfaRequired: false, user: next };
  }, [refreshSession]);

  const signUp = useCallback(async (name: string, email: string, password: string, marketingConsent = false) => {
    const result = await api.post<{ verificationRequired?: boolean }>('/api/register', {
      name,
      email,
      password,
      acceptAll: true,
      marketingConsent,
      legalVersion: LEGAL_DOCUMENT_VERSION,
      source: 'mobile',
    }, { allowUnauthorized: true });
    if (!result?.verificationRequired) throw new Error('No se pudo iniciar la verificación del correo.');
  }, []);

  const verifyMfa = useCallback(async (code: string) => {
    await api.post('/api/auth/mfa/verify', { code }, { allowUnauthorized: true });
    const next = await refreshSession();
    if (!next) throw new Error('No se pudo completar el acceso seguro.');
    return next;
  }, [refreshSession]);

  const verifyEmail = useCallback(async (token: string) => {
    await api.post('/api/auth/verify-email', { token }, { allowUnauthorized: true });
    const next = await refreshSession();
    if (!next) throw new Error('Correo verificado, pero no se pudo abrir la sesión.');
    return next;
  }, [refreshSession]);

  const clearLocalSession = useCallback(async () => {
    await clearAuthTokens();
    setUser(null);
  }, []);

  const signOut = useCallback(async () => {
    try { await api.post('/api/auth/logout', {}, { allowUnauthorized: true }); } catch {}
    await clearAuthTokens();
    setUser(null);
  }, []);

  const value = useMemo(() => ({
    user, loading, refreshSession, signIn, signUp, verifyMfa, verifyEmail, clearLocalSession, signOut,
  }), [user, loading, refreshSession, signIn, signUp, verifyMfa, verifyEmail, clearLocalSession, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
