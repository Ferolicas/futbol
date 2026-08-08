'use client';

import { useEffect, useState } from 'react';

/**
 * Detección de iOS (iPhone/iPad, incluido el iPad que se anuncia como MacIntel).
 * Cubre también Chrome y Firefox en iOS, que por obligación usan WebKit.
 */
export function detectIOS() {
  if (typeof navigator === 'undefined') return false;
  const userAgent = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/**
 * Devuelve false en servidor y en el primer render del cliente, y pasa a true
 * en un efecto. Así la hidratación coincide siempre con el HTML del servidor.
 */
export function useIsIOS() {
  const [isIOS, setIsIOS] = useState(false);
  useEffect(() => {
    setIsIOS(detectIOS());
  }, []);
  return isIOS;
}
