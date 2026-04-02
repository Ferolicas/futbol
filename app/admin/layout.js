'use client';

import { useAuth } from '../../components/providers';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function AdminLayout({ children }) {
  const { user, loading: authLoading, supabase } = useAuth();
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push('/sign-in');
      return;
    }

    fetch('/api/user/role')
      .then(r => r.json())
      .then(data => {
        if (data.role === 'admin' || data.role === 'owner') {
          setIsAdmin(true);
        } else {
          router.push('/dashboard');
        }
      })
      .catch(() => router.push('/dashboard'))
      .finally(() => setChecking(false));
  }, [user, authLoading, router]);

  if (authLoading || checking) return <div className="admin-layout"><p>Cargando...</p></div>;
  if (!isAdmin) return null;

  return (
    <div className="admin-layout">
      <header className="admin-header">
        <div className="admin-header-left">
          <img src="/vflogo.png" alt="CFanalisis" className="admin-logo" />
          <h1>Panel de Administracion</h1>
        </div>
        <div className="admin-header-right">
          <a href="/dashboard" className="admin-link">Dashboard</a>
          <button className="admin-signout" onClick={async () => { await supabase?.auth.signOut(); window.location.href = '/'; }}>Salir</button>
        </div>
      </header>
      {children}
    </div>
  );
}
