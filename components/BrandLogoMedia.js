'use client';

import { useEffect, useState } from 'react';

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
  const [useFallback, setUseFallback] = useState(false);

  useEffect(() => {
    setUseFallback(needsAlphaFallback());
  }, []);

  if (useFallback) {
    return (
      <img
        className={`${className} brand-logo-alpha-fallback`.trim()}
        src="/logo-metalizado-alpha.webp"
        alt={ariaLabel}
        draggable="false"
      />
    );
  }

  return (
    <video
      className={`${className} brand-logo-alpha-video`.trim()}
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      aria-label={ariaLabel}
      onError={() => setUseFallback(true)}
    >
      <source src="/logo-metalizado.webm" type="video/webm" />
    </video>
  );
}
