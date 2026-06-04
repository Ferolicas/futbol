'use client';

import { useEffect } from 'react';

// Error boundary raíz (FE-4). Captura errores en el propio RootLayout, así que
// REEMPLAZA <html>/<body> y debe renderizarlos él mismo. UI mínima — aquí no
// hay layout ni fuentes del proyecto disponibles.
export default function GlobalError({ error, reset }) {
  useEffect(() => {
    console.error('[global:error]', error);
  }, [error]);

  return (
    <html lang="es">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0e12',
          color: '#e2e8f0',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          textAlign: 'center',
          padding: 24,
        }}
      >
        <div>
          <h1 style={{ margin: '0 0 16px', fontSize: 24, fontWeight: 700, color: '#00e676' }}>
            Error
          </h1>
          <button
            onClick={() => reset()}
            style={{
              background: '#00e676',
              color: '#03120a',
              border: 'none',
              borderRadius: 10,
              padding: '10px 22px',
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Recargar
          </button>
        </div>
      </body>
    </html>
  );
}
