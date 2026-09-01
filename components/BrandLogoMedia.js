'use client';

import { useEffect, useState } from 'react';

// Los WebM históricos están codificados como yuv420p: pese al nombre del
// archivo, no contienen canal alfa. El AVIF animado sí conserva transparencia
// real y funciona como fuente única en los navegadores actuales.
const ANIMATED_LOGO = '/logo-metalizado-alpha.avif?v=2';
const STATIC_FALLBACK = '/logo-metalizado-alpha-fast.webp';

export default function BrandLogoMedia({ className = '', ariaLabel = 'CF Análisis' }) {
  const [mode, setMode] = useState('static');

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setMode('static');
      return undefined;
    }
    const probe = new Image();
    probe.onload = () => setMode('animated');
    probe.onerror = () => setMode('static');
    probe.src = ANIMATED_LOGO;
    return () => {
      probe.onload = null;
      probe.onerror = null;
    };
  }, []);

  return (
    <img
      className={`${className} brand-logo-alpha-fallback`.trim()}
      src={mode === 'animated' ? ANIMATED_LOGO : STATIC_FALLBACK}
      style={mode === 'animated' ? { aspectRatio: '512 / 288', objectFit: 'contain' } : undefined}
      alt={ariaLabel}
      decoding="async"
      draggable="false"
      onError={() => setMode('static')}
    />
  );
}
