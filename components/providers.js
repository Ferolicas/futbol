'use client';
import { createContext, useContext, useEffect, useState, useCallback } from 'react';

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
  const supabase = {
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
  };

  return (
    <AuthContext.Provider value={{ user, loading, supabase, refreshSession }}>
      {user && <TimezoneSync />}
      {children}
    </AuthContext.Provider>
  );
}
