'use client';

import { useEffect } from 'react';

// Error boundary del segmento /dashboard (FE-4). Next lo monta si cualquier
// componente del subárbol lanza durante el render. Aísla el fallo a esta
// sección y ofrece reintentar sin recargar toda la app.
export default function DashboardError({ error, reset }) {
  useEffect(() => {
    console.error('[dashboard:error]', error);
  }, [error]);

  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          background: '#0f1419',
          border: '1px solid #1f2a30',
          borderRadius: 16,
          padding: '32px 28px',
          maxWidth: 420,
          width: '100%',
          textAlign: 'center',
          color: '#e2e8f0',
          boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
        }}
      >
        <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 700, color: '#00e676' }}>
          Algo salió mal
        </h2>
        <p style={{ margin: '0 0 20px', fontSize: 14, lineHeight: 1.5, opacity: 0.8 }}>
          No pudimos cargar esta sección. Suele ser un problema temporal — vuelve a intentarlo.
        </p>
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
          Reintentar
        </button>
      </div>
    </div>
  );
}
