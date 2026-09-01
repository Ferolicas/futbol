'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  BaloncestoIcon,
  BaseballIcon,
  FutbolAmericanoIcon,
  FutbolIcon,
  TenisIcon,
} from './SportIcons';

const SPORTS = [
  { key: 'futbol', label: 'Fútbol', detail: 'Partidos y combinadas', path: '/dashboard', icon: FutbolIcon },
  { key: 'baseball', label: 'Béisbol', detail: 'MLB', path: '/dashboard?sport=baseball', icon: BaseballIcon },
  { key: 'basketball', label: 'Baloncesto', detail: 'NBA y NCAA', path: '/dashboard?sport=basketball', icon: BaloncestoIcon },
  { key: 'american_football', label: 'Fútbol americano', detail: 'NFL y NCAA', path: '/dashboard?sport=american_football', icon: FutbolAmericanoIcon },
  { key: 'tennis', label: 'Tenis', detail: 'Próximamente', path: null, icon: TenisIcon, disabled: true },
];

/**
 * Selector segmentado entre los productos deportivos disponibles. Tenis
 * permanece visible pero deshabilitado hasta disponer de una fuente de datos
 * adecuada.
 */
export default function SportToggle() {
  const pathname = usePathname();
  const router = useRouter();
  const [pendingSport, setPendingSport] = useState(null);

  const sport = pathname?.startsWith('/dashboard/baseball') ? 'baseball'
    : pathname?.startsWith('/dashboard/baloncesto') ? 'basketball'
    : pathname?.startsWith('/dashboard/futbol-americano') ? 'american_football'
    : 'futbol';

  useEffect(() => {
    SPORTS.filter((item) => item.path).forEach((item) => router.prefetch(item.path));
  }, [router]);

  useEffect(() => {
    setPendingSport(null);
  }, [pathname]);

  const goTo = (target) => {
    const destination = SPORTS.find((item) => item.key === target);
    if (!destination?.path || target === sport) return;
    setPendingSport(target);
    router.push(destination.path);
  };

  // El indicador se adelanta al destino en cuanto se pulsa, para que el cambio
  // se sienta inmediato aunque la ruta tarde en montar.
  const highlighted = pendingSport || sport;
  const highlightedIndex = Math.max(0, SPORTS.findIndex((item) => item.key === highlighted));

  return (
    <div
      className={`sport-switcher ${pendingSport ? 'is-pending' : ''}`}
      style={{ '--sport-active-index': highlightedIndex }}
      role="group"
      aria-label="Cambiar deporte"
    >
      <span className="sport-switcher-indicator" aria-hidden="true" />

      {SPORTS.map((item) => {
        const Icon = item.icon;
        const isActive = sport === item.key;
        return (
          <button
            key={item.key}
            type="button"
            className="sport-switcher-option"
            data-sport={item.key}
            data-label={item.disabled ? `${item.label} · ${item.detail}` : item.label}
            data-active={highlighted === item.key || undefined}
            aria-label={item.disabled ? `${item.label} (${item.detail})` : item.label}
            aria-current={isActive ? 'page' : undefined}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            onClick={() => goTo(item.key)}
            onPointerEnter={() => item.path && router.prefetch(item.path)}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}
