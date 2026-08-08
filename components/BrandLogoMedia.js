'use client';

import { useEffect, useRef, useState } from 'react';

const mountedLogoVideos = new Set();

function syncLogoPlayback() {
  if (typeof document === 'undefined') return;
  const videos = [...mountedLogoVideos].filter(video => video?.isConnected);
  const active = document.hidden ? null : videos[videos.length - 1];
  for (const video of videos) {
    if (video === active) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }
}

function needsAlphaFallback() {
  const userAgent = window.navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(userAgent) ||
    (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
  const isDesktopSafari =
    /Safari/.test(userAgent) &&
    !/Chrome|Chromium|CriOS|Edg|OPR|Android/.test(userAgent);

  return isIOS || isDesktopSafari;
}

// Safari no compone el canal alfa del WebM (VP9), por eso allí se sirve un AVIF
// animado: mismo lienzo, misma animación y 228 KB, menos que el propio WebM. Su
// primer fotograma ya es el logo asentado, así que un navegador que soporte AVIF
// fijo pero no secuencias muestra exactamente lo mismo que el WebP de siempre.
const ANIMATED_FALLBACK = '/logo-metalizado-alpha.avif';
const STATIC_FALLBACK = '/logo-metalizado-alpha-fast.webp';

export default function BrandLogoMedia({ className = '', ariaLabel = 'CF Análisis' }) {
  // null = aún sin decidir (SSR/hidratación) · 'video' · 'animated' · 'static'
  const [mode, setMode] = useState(null);
  const [animatedReady, setAnimatedReady] = useState(false);
  const videoRef = useRef(null);
  const useFallback = mode === null ? null : mode !== 'video';

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setMode('static');
      return undefined;
    }
    if (!needsAlphaFallback()) {
      setMode('video');
      return undefined;
    }
    setMode('animated');
    // Se precarga aparte: hasta que el AVIF no está decodificado se sigue viendo
    // el WebP de 14 KB, y si el navegador no sabe decodificarlo se queda en él.
    const probe = new Image();
    probe.onload = () => setAnimatedReady(true);
    probe.src = ANIMATED_FALLBACK;
    return () => {
      probe.onload = null;
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (useFallback !== false || !video) return;
    mountedLogoVideos.add(video);
    document.addEventListener('visibilitychange', syncLogoPlayback);
    syncLogoPlayback();
    return () => {
      mountedLogoVideos.delete(video);
      document.removeEventListener('visibilitychange', syncLogoPlayback);
      syncLogoPlayback();
    };
  }, [useFallback]);

  // La imagen de 14 KB también actúa como primer frame durante la hidratación,
  // evitando que Safari empiece a descargar el WebM antes de elegir fallback.
  if (useFallback !== false) {
    return (
      <img
        className={`${className} brand-logo-alpha-fallback`.trim()}
        src={animatedReady ? ANIMATED_FALLBACK : STATIC_FALLBACK}
        // El AVIF trae el lienzo completo del vídeo (512×288) y el WebP solo la
        // banda del logo (512×123). En la rama animada se reserva desde el
        // principio la proporción del vídeo y se encaja por `contain`: el logo
        // sale del mismo tamaño y en el mismo sitio en ambos, así que el relevo
        // WebP → AVIF no mueve nada de la página. Con movimiento reducido no se
        // toca nada y se sigue viendo el WebP tal cual.
        style={mode === 'animated' ? { aspectRatio: '512 / 288', objectFit: 'contain' } : undefined}
        alt={ariaLabel}
        decoding="async"
        draggable="false"
      />
    );
  }

  return (
    <video
      ref={videoRef}
      className={`${className} brand-logo-alpha-video`.trim()}
      muted
      loop
      playsInline
      preload="auto"
      poster={STATIC_FALLBACK}
      aria-label={ariaLabel}
      onError={() => setMode('static')}
    >
      <source src="/logo-metalizado-fast.webm" type="video/webm" />
    </video>
  );
}
