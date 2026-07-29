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

export default function BrandLogoMedia({ className = '', ariaLabel = 'CF Análisis' }) {
  const [useFallback, setUseFallback] = useState(null);
  const videoRef = useRef(null);

  useEffect(() => {
    setUseFallback(
      needsAlphaFallback() ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    );
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
        src="/logo-metalizado-alpha-fast.webp"
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
      poster="/logo-metalizado-alpha-fast.webp"
      aria-label={ariaLabel}
      onError={() => setUseFallback(true)}
    >
      <source src="/logo-metalizado-fast.webm" type="video/webm" />
    </video>
  );
}
