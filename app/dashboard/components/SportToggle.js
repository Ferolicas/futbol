'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronDown, LoaderCircle } from 'lucide-react';

function FootballBallIcon({ size = 18, className = '' }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
      <path d="m12 7.1 3.15 2.28-1.2 3.7h-3.9l-1.2-3.7L12 7.1Z" fill="currentColor" />
      <path d="m12 7.1-.78-3M8.85 9.38 5.3 8.9m4.75 4.18-2.2 3.13m6.1-3.13 2.2 3.13m-.99-6.83 3.54-.48M7.85 16.21l-2.06 1.45m10.36-1.45 2.06 1.45M10.05 13.08l-2.2 3.13m6.1-3.13 2.2 3.13M7.85 16.21l1.03 3.18m7.27-3.18-1.03 3.18" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function BaseballGloveIcon({ size = 18, className = '' }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path d="M8.15 12.1 6.8 7.25c-.25-.9.27-1.83 1.17-2.08.9-.25 1.83.27 2.08 1.17l1.02 3.69-.87-5.06a1.7 1.7 0 0 1 3.35-.58l.88 5.1-.22-4.23a1.7 1.7 0 0 1 3.39-.18l.3 5.75.4-2.14a1.7 1.7 0 0 1 3.34.63l-.92 4.91c-.75 4-4.24 6.9-8.3 6.9h-.64a7.9 7.9 0 0 1-7.46-5.28l-1.12-3.2a1.84 1.84 0 0 1 3.15-1.8l1.8 1.25Z" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.15 12.1c1.58.57 2.8 1.7 3.56 3.08m-.64-5.15.64 2.2m2.72-2.74.16 2.3m3.31-.96-.26 1.7" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function BasketballIcon({ size = 18, className = '' }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
      <path d="M4.1 9.4c5.1.3 9.2 4.4 9.5 10.5M10.4 4.1c.3 5.1 4.4 9.2 9.5 9.5M3.2 13.8 20.8 10.2M10.2 20.8 13.8 3.2" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}

function AmericanFootballIcon({ size = 18, className = '' }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.2 16.7C1.8 13.2 4.1 7.6 8.7 4.8c4.6-2.8 9.8-2.1 11.1.1 1.4 2.3-.9 7.8-5.5 10.6-4.5 2.8-8.5 3.4-10.1 1.2Z" stroke="currentColor" strokeWidth="1.65" />
      <path d="m8.5 13.4 6.8-4.2m-5.2 1.2 3.5 2.8m-2.1-4.1 3.4 2.7" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}

function TennisIcon({ size = 18, className = '' }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5.2 5.7c3.9 1.6 5.2 5.6 4.1 8.4-.8 2.1-2.5 3.6-4.7 4.2M18.8 18.3c-3.9-1.6-5.2-5.6-4.1-8.4.8-2.1 2.5-3.6 4.7-4.2" stroke="currentColor" strokeWidth="1.45" />
    </svg>
  );
}

const SPORTS = [
  { key: 'futbol', label: 'Fútbol', detail: 'Partidos y combinadas', path: '/dashboard', icon: FootballBallIcon },
  { key: 'baseball', label: 'Baseball', detail: 'MLB y ligas menores', path: '/dashboard/baseball', icon: BaseballGloveIcon },
  { key: 'basketball', label: 'Baloncesto', detail: 'NBA y NCAA', path: '/dashboard/baloncesto', icon: BasketballIcon },
  { key: 'american_football', label: 'Fútbol americano', detail: 'NFL y NCAA', path: '/dashboard/futbol-americano', icon: AmericanFootballIcon },
  { key: 'tennis', label: 'Tenis', detail: 'Próximamente', path: null, icon: TennisIcon, disabled: true },
];

/**
 * Selector móvil entre los productos deportivos disponibles. Tenis permanece
 * visible pero deshabilitado hasta disponer de una fuente de datos adecuada.
 */
export default function SportToggle() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pendingSport, setPendingSport] = useState(null);
  const menuRef = useRef(null);

  const sport = pathname?.startsWith('/dashboard/baseball') ? 'baseball'
    : pathname?.startsWith('/dashboard/baloncesto') ? 'basketball'
    : pathname?.startsWith('/dashboard/futbol-americano') ? 'american_football'
    : 'futbol';
  const current = SPORTS.find((item) => item.key === sport) || SPORTS[0];

  useEffect(() => {
    SPORTS.filter((item) => item.path).forEach((item) => router.prefetch(item.path));
  }, [router]);

  useEffect(() => {
    setPendingSport(null);
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutside = (event) => {
      if (!menuRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const goTo = (target) => {
    const destination = SPORTS.find((item) => item.key === target);
    if (!destination?.path || target === sport) return;
    setPendingSport(target);
    setOpen(false);
    router.push(destination.path);
  };

  const CurrentIcon = current.icon;

  return (
    <div className="sport-menu" ref={menuRef}>
      <button
        type="button"
        className={`sport-menu-trigger ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Cambiar deporte"
      >
        {pendingSport
          ? <LoaderCircle className="sport-menu-loader" size={16} aria-hidden="true" />
          : <CurrentIcon size={16} strokeWidth={2} aria-hidden="true" />}
        <span>{pendingSport ? `Abriendo ${SPORTS.find((item) => item.key === pendingSport)?.label || ''}` : current.label}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>

      {open && (
        <div className="sport-menu-popover" role="listbox" aria-label="Seleccionar deporte">
          {SPORTS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                className={`${sport === item.key ? 'is-active' : ''} ${item.disabled ? 'is-disabled' : ''}`}
                onClick={() => goTo(item.key)}
                onPointerEnter={() => item.path && router.prefetch(item.path)}
                role="option"
                aria-selected={sport === item.key}
                aria-disabled={item.disabled || undefined}
                disabled={item.disabled}
              >
                <span className={`sport-menu-icon ${item.key}`}><Icon size={18} /></span>
                <span><strong>{item.label}</strong><small>{item.detail}</small></span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
