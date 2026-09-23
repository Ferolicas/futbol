'use client';

import { useEffect, useState } from 'react';

// Los WebM históricos están codificados como yuv420p: pese al nombre del
// archivo, no contienen canal alfa. El AVIF animado sí conserva transparencia
// real y funciona como fuente única en los navegadores actuales.
const ANIMATED_LOGO = '/logo-metalizado-alpha.avif?v=2';
const STATIC_FALLBACK = '/logo-metalizado-alpha-fast.webp';

// deferred: pinta el estático y solo carga el AVIF animado cuando la página
// ya terminó de cargar y el navegador está ocioso — así el dashboard conserva
// el arranque sin bloqueos (17c9256) y el logo del nav igual se anima.
export default function BrandLogoMedia({ className = '', ariaLabel = 'CF Análisis', animated = true, deferred = false }) {
  const [mode, setMode] = useState('static');

  useEffect(() => {
    if (!animated) {
      setMode('static');
      return undefined;
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setMode('static');
      return undefined;
    }
    let probe = null;
    let idleId = null;
    let timeoutId = null;
    const start = () => {
      probe = new Image();
      probe.onload = () => setMode('animated');
      probe.onerror = () => setMode('static');
      probe.src = ANIMATED_LOGO;
    };
    const scheduleIdle = () => {
      if (window.requestIdleCallback) idleId = window.requestIdleCallback(start, { timeout: 4000 });
      else timeoutId = window.setTimeout(start, 1500);
    };
    if (!deferred) start();
    else if (document.readyState === 'complete') scheduleIdle();
    else window.addEventListener('load', scheduleIdle, { once: true });
    return () => {
      window.removeEventListener('load', scheduleIdle);
      if (idleId != null) window.cancelIdleCallback?.(idleId);
      if (timeoutId != null) window.clearTimeout(timeoutId);
      if (probe) { probe.onload = null; probe.onerror = null; }
    };
  }, [animated, deferred]);

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
