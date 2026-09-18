import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, onUnauthorized } from './api';
import { getSessionToken, setSessionToken } from './session';
import { getUserTz } from './timezone';

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
}

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  refreshSession: () => Promise<SessionUser | null>;
  signIn: (email: string, password: string) => Promise<SessionUser>;
  signUp: (name: string, email: string, password: string) => Promise<SessionUser>;
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
      if (!next) await setSessionToken(null);
      setUser(next);
      return next;
    } catch {
      return user;
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { refreshSession(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => onUnauthorized(() => {
    setSessionToken(null);
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
    await api.post('/api/auth/login', { email, password }, { allowUnauthorized: true });
    const token = await getSessionToken();
    if (!token) throw new Error('No recibimos la sesión del servidor. Intenta de nuevo.');
    const next = await refreshSession();
    if (!next) throw new Error('No se pudo iniciar la sesión.');
    return next;
  }, [refreshSession]);

  const signUp = useCallback(async (name: string, email: string, password: string) => {
    await api.post('/api/register', { name, email, password }, { allowUnauthorized: true });
    const token = await getSessionToken();
    if (!token) throw new Error('Cuenta creada, pero no recibimos la sesión. Inicia sesión.');
    const next = await refreshSession();
    if (!next) throw new Error('Cuenta creada. Inicia sesión para continuar.');
    return next;
  }, [refreshSession]);

  const signOut = useCallback(async () => {
    try { await api.post('/api/auth/logout', {}, { allowUnauthorized: true }); } catch {}
    await setSessionToken(null);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, loading, refreshSession, signIn, signUp, signOut }), [user, loading, refreshSession, signIn, signUp, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
