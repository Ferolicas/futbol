'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut, UserRound } from 'lucide-react';
import BrandLogoMedia from '../../../components/BrandLogoMedia';
import { useAuth } from '../../../components/providers';
import SportToggle from './SportToggle';

export default function DashboardHeader({ initialUser }) {
  const { user, supabase } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const menuRef = useRef(null);
  const resolvedUser = user || initialUser;
  const fullName = resolvedUser?.name || resolvedUser?.displayName || resolvedUser?.email?.split('@')[0] || 'Mi cuenta';
  const firstName = fullName.trim().split(/\s+/)[0] || 'Mi cuenta';
  const initial = firstName.charAt(0).toUpperCase();

  useEffect(() => {
    if (!menuOpen) return undefined;

    const closeOnOutside = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  const signOut = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await supabase?.auth.signOut();
    } finally {
      window.location.assign('/');
    }
  };

  return (
    <header className="dashboard-topbar">
      <Link href="/dashboard" className="dashboard-brand" aria-label="Ir al dashboard">
        <BrandLogoMedia />
      </Link>

      <SportToggle />

      <div className="dashboard-account" ref={menuRef}>
        <button
          type="button"
          className={`dashboard-account-trigger ${menuOpen ? 'is-open' : ''}`}
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <span className="dashboard-avatar" aria-hidden="true">
            {initial || <UserRound size={17} />}
          </span>
          <span className="dashboard-account-name">{firstName}</span>
          <ChevronDown size={15} aria-hidden="true" />
        </button>

        {menuOpen && (
          <div className="dashboard-account-menu" role="menu">
            <div className="dashboard-account-meta">
              <strong>{fullName}</strong>
              <span>{resolvedUser?.email}</span>
            </div>
            <button type="button" onClick={signOut} disabled={loggingOut} role="menuitem">
              <LogOut size={16} aria-hidden="true" />
              {loggingOut ? 'Cerrando sesión…' : 'Salir'}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
