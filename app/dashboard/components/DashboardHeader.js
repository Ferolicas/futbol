'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { CalendarX2, ChevronDown, LogOut, UserRound } from 'lucide-react';
import BrandLogoMedia from '../../../components/BrandLogoMedia';
import { useAuth } from '../../../components/providers';
import SportToggle from './SportToggle';

export default function DashboardHeader({ initialUser }) {
  const { user, supabase } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [renewalCancelled, setRenewalCancelled] = useState(!!initialUser?.cancelAtPeriodEnd);
  const [billingMessage, setBillingMessage] = useState('');
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

  const cancelRenewal = async () => {
    if (cancelling || renewalCancelled) return;
    if (!window.confirm('¿Cancelar la renovacion automatica? Mantendras el acceso hasta terminar el periodo ya pagado.')) return;
    setCancelling(true);
    setBillingMessage('');
    try {
      const response = await fetch('/api/payments/cancel', { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'No se pudo cancelar');
      setRenewalCancelled(true);
      const until = data.accessUntil ? new Date(data.accessUntil).toLocaleDateString('es-ES') : null;
      setBillingMessage(until ? `Acceso activo hasta ${until}` : 'Renovacion cancelada');
    } catch (error) {
      setBillingMessage(error.message || 'No se pudo cancelar la renovacion.');
    } finally {
      setCancelling(false);
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
              {(renewalCancelled || billingMessage) && (
                <small className={renewalCancelled ? 'is-success' : ''}>
                  {billingMessage || 'Renovacion automatica cancelada'}
                </small>
              )}
            </div>
            {initialUser?.hasRecurringSubscription && !renewalCancelled && (
              <button type="button" onClick={cancelRenewal} disabled={cancelling} role="menuitem">
                <CalendarX2 size={16} aria-hidden="true" />
                {cancelling ? 'Cancelando renovacion…' : 'Cancelar renovacion'}
              </button>
            )}
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
