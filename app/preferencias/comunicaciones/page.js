'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '../../../components/providers';

export default function CommunicationPreferencesPage() {
  const { user, loading } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!user) return;
    fetch('/api/legal/marketing', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => setEnabled(data.enabled === true))
      .finally(() => setReady(true));
  }, [user]);

  if (!loading && !user) {
    return <main className="preference-page"><section><h1>Preferencias de comunicación</h1><p>Inicia sesión para administrar esta preferencia.</p><Link href="/sign-in">Iniciar sesión</Link></section></main>;
  }

  const save = async (next) => {
    setSaving(true);
    setMessage('');
    const response = await fetch('/api/legal/marketing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next, source: 'web' }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      setEnabled(data.enabled === true);
      setMessage(data.enabled ? 'Aceptaste recibir promociones.' : 'Ya no recibirás comunicaciones promocionales.');
    } else setMessage(data.error || 'No pudimos guardar el cambio.');
    setSaving(false);
  };

  return (
    <main className="preference-page">
      <section>
        <p className="preference-eyebrow">CF Análisis</p>
        <h1>Preferencias de comunicación</h1>
        <p>Los mensajes necesarios sobre seguridad, pagos o cambios del servicio no dependen de esta opción.</p>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!ready || saving}
            onChange={(event) => save(event.target.checked)}
          />
          <span>Recibir descuentos y novedades de CF Análisis por email</span>
        </label>
        {message && <p role="status" className="preference-message">{message}</p>}
        <Link href="/dashboard">Volver al dashboard</Link>
      </section>
    </main>
  );
}
