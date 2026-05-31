'use client';
import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';

const AuthContext = createContext(null);

export function useAuth() {
  return useContext(AuthContext);
}

function TimezoneSync() {
  useEffect(() => {
    // Detect and save timezone on login — once per session
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz) return;

    const saved = sessionStorage.getItem('tz-synced');
    if (saved === tz) return;

    fetch('/api/user/timezone', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: tz }),
    }).then(() => {
      sessionStorage.setItem('tz-synced', tz);
    }).catch(err => console.warn('[TimezoneSync]', err.message));
  }, []);

  return null;
}

// Auth nativo PG VPS. La sesión vive en una cookie httpOnly (JWT) que el
// browser no puede leer; por eso consultamos /api/auth/session. El objeto
// `auth.signOut()` se mantiene en el contexto con la MISMA firma que el
// cliente Supabase para no romper los componentes que llaman
// `supabase.auth.signOut()` (dashboard, planes).
export default function Providers({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refreshSession = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/session', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      setUser(data.user ?? null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refreshSession(); }, [refreshSession]);

  // Shim con la misma forma que el cliente Supabase: `supabase.auth.signOut()`.
  // Internamente hace POST /api/auth/logout (borra sesión PG + cookie).
  // F5 FIX: useMemo para no recrear el shim en CADA render (antes era un objeto
  // nuevo por render → todos los consumidores del contexto re-renderizaban).
  const supabase = useMemo(() => ({
    auth: {
      signOut: async () => {
        try {
          await fetch('/api/auth/logout', { method: 'POST' });
        } catch {}
        setUser(null);
        return { error: null };
      },
      getSession: async () => ({ data: { session: user ? { user } : null } }),
      getUser: async () => ({ data: { user } }),
    },
  }), [user]);

  // El value del provider también memoizado (evita re-render de consumidores
  // por identidad del objeto value en cada render).
  const ctxValue = useMemo(
    () => ({ user, loading, supabase, refreshSession }),
    [user, loading, supabase, refreshSession],
  );

  return (
    <AuthContext.Provider value={ctxValue}>
      {user && <TimezoneSync />}
      {children}
    </AuthContext.Provider>
  );
}
