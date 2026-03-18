'use client';

import { useUser, useClerk } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function AdminLayout({ children }) {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!isLoaded) return;
    if (!user) {
      router.push('/sign-in');
      return;
    }

    // Check admin role from Sanity
    fetch('/api/user/role')
      .then(r => r.json())
      .then(data => {
        if (data.role === 'admin') {
          setIsAdmin(true);
        } else {
          router.push('/dashboard');
        }
      })
      .catch(() => router.push('/dashboard'))
      .finally(() => setChecking(false));
  }, [user, isLoaded, router]);

  if (!isLoaded || checking) return <div className="admin-layout"><p>Cargando...</p></div>;
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
          <button className="admin-signout" onClick={() => signOut({ redirectUrl: '/' })}>Salir</button>
        </div>
      </header>
      {children}
    </div>
  );
}
