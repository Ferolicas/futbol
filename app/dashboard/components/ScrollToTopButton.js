'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpToLine } from 'lucide-react';

export default function ScrollToTopButton() {
  const [visible, setVisible] = useState(false);
  const correctionFrames = useRef([]);

  useEffect(() => {
    let frame = null;
    const update = () => {
      if (frame != null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setVisible(window.scrollY > 520);
      });
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => {
      window.removeEventListener('scroll', update);
      if (frame != null) cancelAnimationFrame(frame);
      correctionFrames.current.forEach(cancelAnimationFrame);
      correctionFrames.current = [];
    };
  }, []);

  const goTop = () => {
    // Una animación suave a través de cientos de filas virtualizadas puede
    // interrumpirse cuando cambia la altura medida de la lista. Saltamos de
    // forma inmediata y repetimos la posición durante dos frames para cubrir
    // el reajuste de @tanstack/react-virtual y el scroll inercial de Safari.
    const resetPosition = () => {
      const scrollRoot = document.scrollingElement || document.documentElement;
      scrollRoot?.scrollTo?.({ top: 0, left: 0, behavior: 'auto' });
      if (scrollRoot) scrollRoot.scrollTop = 0;
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      window.scrollTo(0, 0);
    };

    correctionFrames.current.forEach(cancelAnimationFrame);
    correctionFrames.current = [];
    resetPosition();
    setVisible(false);

    const firstFrame = requestAnimationFrame(() => {
      resetPosition();
      const secondFrame = requestAnimationFrame(resetPosition);
      correctionFrames.current = [secondFrame];
    });
    correctionFrames.current = [firstFrame];
  };

  return (
    <button
      type="button"
      className={`scroll-top-trigger ${visible ? 'is-visible' : ''}`}
      onClick={goTop}
      aria-label="Ir al inicio de la página"
      title="Ir arriba"
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
    >
      <ArrowUpToLine size={18} aria-hidden="true" />
      <span>Arriba</span>
    </button>
  );
}
