'use client';

import { useEffect, useRef, useState } from 'react';

// MP4/H.264 evita la clasificación `audio/webm` del file_server de Caddy y
// tiene soporte más consistente en Safari/iOS sin perder el loop de 6 s.
const VIDEO = '/logo-metalizado-fast.mp4';
const FALLBACK = '/logo-metalizado-alpha-fast.webp';

export default function LandingBrandVideo({ className = '', ariaLabel = 'CF Análisis' }) {
  const videoRef = useRef(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setFallback(true);
      return undefined;
    }
    const video = videoRef.current;
    if (!video) return undefined;
    const resume = () => {
      if (document.visibilityState !== 'hidden') video.play().catch(() => {});
    };
    resume();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('pointerdown', resume, { once: true });
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('pointerdown', resume);
    };
  }, []);

  if (fallback) {
    return <img className={`${className} brand-logo-alpha-fallback`.trim()} src={FALLBACK} alt={ariaLabel} decoding="async" draggable="false" />;
  }
  return (
    <video
      ref={videoRef}
      className={`${className} brand-logo-reliable-video`.trim()}
      src={VIDEO}
      poster={FALLBACK}
      aria-label={ariaLabel}
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
      disablePictureInPicture
      onCanPlay={(event) => event.currentTarget.play().catch(() => {})}
      onError={() => setFallback(true)}
    />
  );
}
