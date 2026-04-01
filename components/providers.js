'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '../lib/supabase-client';

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

export default function Providers({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const supabase = getSupabaseBrowserClient();

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, supabase }}>
      {user && <TimezoneSync />}
      {children}
    </AuthContext.Provider>
  );
}
