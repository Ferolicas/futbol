'use client';

import { useSession, signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function AdminLayout({ children }) {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === 'authenticated' && session?.user?.role !== 'admin') {
      router.push('/dashboard');
    }
  }, [session, status, router]);

  if (status === 'loading') return <div className="admin-layout"><p>Cargando...</p></div>;
  if (session?.user?.role !== 'admin') return null;

  return (
    <div className="admin-layout">
      <header className="admin-header">
        <div className="admin-header-left">
          <img src="/vflogo.png" alt="CFanalisis" className="admin-logo" />
          <h1>Panel de Administracion</h1>
        </div>
        <div className="admin-header-right">
          <a href="/dashboard" className="admin-link">Dashboard</a>
          <button className="admin-signout" onClick={() => signOut({ callbackUrl: '/login' })}>Salir</button>
        </div>
      </header>
      {children}
    </div>
  );
}
