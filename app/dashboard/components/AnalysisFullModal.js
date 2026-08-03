'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import BrandLogoMedia from '../../../components/BrandLogoMedia';

/**
 * Carcasa compartida del análisis completo.
 *
 * El contenido conserva su flujo vertical real: no interceptamos wheel,
 * pointer, touch ni teclado, y no convertimos las secciones en diapositivas.
 * El único scroll pertenece a `.analysis-native-body`, por lo que navegador,
 * trackpad e iOS aplican su comportamiento nativo.
 */
export default function AnalysisFullModal({
  children,
  onClose,
  variant = 'football',
  bodyClassName = '',
  ariaLabel = 'Análisis completo',
}) {
  const closeRef = useRef(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus({ preventScroll: true });

    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose]);

  const baseball = variant === 'baseball';

  const modal = (
    <div
      className={`analysis-native-modal ${baseball ? 'is-baseball' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <button className="analysis-native-backdrop" onClick={onClose} aria-label="Cerrar análisis" />
      <section className={`analysis-native-shell ${baseball ? 'is-baseball' : ''}`}>
        <header className="analysis-native-header">
          <div className="analysis-native-brand is-logo-only">
            <BrandLogoMedia />
          </div>
          <button
            ref={closeRef}
            className="analysis-native-close"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div
          className={`analysis-native-body ${bodyClassName}`.trim()}
          aria-label="Contenido del análisis"
          tabIndex={0}
        >
          {children}
        </div>
      </section>
    </div>
  );

  // El dashboard anima su contenedor al entrar y eso crea un contexto de
  // apilado propio. Si el modal vive dentro de ese árbol, el header sticky de
  // la app puede quedar por encima aunque el modal tenga un z-index mayor.
  // El portal lo monta en <body>, donde la carcasa y su botón de cierre
  // compiten en el contexto raíz y permanecen siempre sobre la navegación.
  if (typeof document === 'undefined') return null;
  return createPortal(modal, document.body);
}
