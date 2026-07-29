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

/**
 * Sport toggle: switches between fútbol (/dashboard) and baseball (/dashboard/baseball).
 * Renders as a sticky pill at the top of the dashboard.
 */
export default function SportToggle() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pendingSport, setPendingSport] = useState(null);
  const menuRef = useRef(null);

  const isBaseball = pathname?.startsWith('/dashboard/baseball');
  const sport = isBaseball ? 'baseball' : 'futbol';

  useEffect(() => {
    router.prefetch('/dashboard');
    router.prefetch('/dashboard/baseball');
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
    if (target === sport) return;
    setPendingSport(target);
    setOpen(false);
    if (target === 'baseball') router.push('/dashboard/baseball');
    else router.push('/dashboard');
  };

  const CurrentIcon = isBaseball ? BaseballGloveIcon : FootballBallIcon;

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
        <span>{pendingSport === 'baseball' ? 'Abriendo Baseball' : pendingSport === 'futbol' ? 'Abriendo Fútbol' : isBaseball ? 'Baseball' : 'Fútbol'}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>

      {open && (
        <div className="sport-menu-popover" role="listbox" aria-label="Seleccionar deporte">
          <button
            type="button"
            className={!isBaseball ? 'is-active' : ''}
            onClick={() => goTo('futbol')}
            onPointerEnter={() => router.prefetch('/dashboard')}
            role="option"
            aria-selected={!isBaseball}
          >
            <span className="sport-menu-icon football"><FootballBallIcon size={18} /></span>
            <span><strong>Fútbol</strong><small>Partidos y combinadas</small></span>
          </button>
          <button
            type="button"
            className={isBaseball ? 'is-active' : ''}
            onClick={() => goTo('baseball')}
            onPointerEnter={() => router.prefetch('/dashboard/baseball')}
            role="option"
            aria-selected={isBaseball}
          >
            <span className="sport-menu-icon baseball"><BaseballGloveIcon size={18} /></span>
            <span><strong>Baseball</strong><small>MLB y apuestas del día</small></span>
          </button>
        </div>
      )}
    </div>
  );
}
