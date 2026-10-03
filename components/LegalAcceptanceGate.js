'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FileCheck2, LoaderCircle, ShieldCheck } from 'lucide-react';

export default function LegalAcceptanceGate({ user, refreshSession }) {
  const pathname = usePathname();
  const dialogRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [legalConfirmed, setLegalConfirmed] = useState(false);
  const required = user?.legalAcceptanceRequired === true;
  const readingLegalDocument = ['/terminos', '/privacidad', '/cookies'].includes(pathname);

  useEffect(() => {
    if (required) dialogRef.current?.focus();
  }, [required]);

  // Los documentos deben poder leerse antes de aceptarlos, incluso si el
  // usuario ya tiene una sesión abierta en esta pestaña o en otra.
  if (!required || readingLegalDocument) return null;

  const accept = async () => {
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/legal/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          acceptAll: true,
          version: user.legalDocumentVersion,
          source: 'web',
          marketingConsent,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'No pudimos guardar tu aceptación.');
      await refreshSession();
    } catch (cause) {
      setError(cause.message || 'No pudimos guardar tu aceptación.');
      setSubmitting(false);
    }
  };

  return (
    <div className="legal-gate-overlay" role="presentation">
      <section
        ref={dialogRef}
        className="legal-gate-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="legal-gate-title"
        tabIndex={-1}
      >
        <span className="legal-gate-icon"><FileCheck2 size={25} aria-hidden="true" /></span>
        <p className="legal-gate-eyebrow">Documentos legales actualizados</p>
        <h2 id="legal-gate-title">Una sola confirmación para continuar</h2>
        <p>
          Revisa los documentos. Al pulsar el botón confirmas que eres mayor de 18 años,
          aceptas los Términos, reconoces haber leído las políticas y autorizas expresamente
          el tratamiento necesario de tus datos según la Política de Privacidad.
        </p>
        <nav className="legal-gate-links" aria-label="Documentos legales">
          <Link href="/terminos" target="_blank">Términos y condiciones</Link>
          <Link href="/privacidad" target="_blank">Privacidad y tratamiento</Link>
          <Link href="/cookies" target="_blank">Cookies</Link>
        </nav>
        <p className="legal-gate-note">
          <ShieldCheck size={15} aria-hidden="true" />
          Esta aceptación no autoriza correos promocionales ni cookies opcionales.
        </p>
        <label className="legal-gate-marketing">
          <input
            type="checkbox"
            checked={legalConfirmed}
            onChange={(event) => setLegalConfirmed(event.target.checked)}
          />
          <span>Confirmo que soy mayor de 18 años, acepto los Términos y autorizo el tratamiento descrito en la Política de Privacidad. También leí la Política de Cookies.</span>
        </label>
        <label className="legal-gate-marketing">
          <input
            type="checkbox"
            checked={marketingConsent}
            onChange={(event) => setMarketingConsent(event.target.checked)}
          />
          <span>Quiero recibir por email descuentos y novedades de CF Análisis. Es opcional y puedo retirarlo cuando quiera.</span>
        </label>
        {error && <p className="legal-gate-error" role="alert">{error}</p>}
        <button type="button" onClick={accept} disabled={submitting || !legalConfirmed}>
          {submitting ? <LoaderCircle className="legal-gate-spinner" size={18} aria-hidden="true" /> : null}
          {submitting ? 'Guardando…' : 'Aceptar todo y continuar'}
        </button>
        <button
          type="button"
          className="legal-gate-logout"
          disabled={submitting}
          onClick={() => fetch('/api/auth/logout', { method: 'POST' }).finally(() => window.location.assign('/'))}
        >No aceptar y cerrar sesión</button>
      </section>
    </div>
  );
}
