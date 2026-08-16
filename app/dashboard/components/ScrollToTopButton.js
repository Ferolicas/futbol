'use client';

import { useEffect, useState } from 'react';
import { ArrowUpToLine } from 'lucide-react';

export default function ScrollToTopButton() {
  const [visible, setVisible] = useState(false);

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
    };
  }, []);

  const goTop = () => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
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
