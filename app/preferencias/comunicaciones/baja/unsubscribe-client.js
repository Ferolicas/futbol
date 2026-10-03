'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function UnsubscribeClient({ token }) {
  const [state, setState] = useState('ready');
  const unsubscribe = async () => {
    setState('loading');
    const response = await fetch('/api/legal/marketing/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    setState(response.ok ? 'done' : 'error');
  };

  return (
    <main className="preference-page">
      <section>
        <p className="preference-eyebrow">CF Análisis</p>
        <h1>Cancelar promociones</h1>
        {state === 'done' ? (
          <p>Listo. No recibirás más descuentos ni novedades promocionales.</p>
        ) : (
          <>
            <p>Dejarás de recibir comunicaciones de marketing. Los avisos indispensables de seguridad, pagos o servicio no se desactivan.</p>
            <button type="button" onClick={unsubscribe} disabled={!token || state === 'loading'}>
              {state === 'loading' ? 'Guardando…' : 'Dejar de recibir promociones'}
            </button>
            {state === 'error' ? <p role="alert">El enlace no es válido o no pudimos procesarlo.</p> : null}
          </>
        )}
        <Link href="/">Volver a CF Análisis</Link>
      </section>
    </main>
  );
}
