'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Clock3, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import BrandLogoMedia from '../../../components/BrandLogoMedia';

export default function PaymentStatusClient({ attemptId }) {
  const [result, setResult] = useState({ status: 'pending', message: 'Confirmando tu pago…' });
  const [checking, setChecking] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const startedAt = useRef(Date.now());
  const stopped = useRef(false);

  const check = useCallback(async () => {
    if (stopped.current) return;
    setChecking(true);
    try {
      const response = await fetch(`/api/payments/status?attempt=${encodeURIComponent(attemptId)}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'No se pudo consultar el pago');
      setResult(data);
      if (data.status === 'succeeded') {
        stopped.current = true;
        window.setTimeout(() => window.location.replace(data.redirectUrl || '/dashboard?checkout=success'), 900);
      } else if (data.status === 'failed') {
        stopped.current = true;
      }
    } catch {
      setResult({
        status: 'pending',
        verificationDelayed: true,
        message: 'El proveedor esta tardando en responder. Tu operacion sigue guardada y puedes volver a comprobarla.',
      });
    } finally {
      setChecking(false);
    }
  }, [attemptId]);

  const cancelAttempt = async () => {
    if (cancelling || stopped.current) return;
    setCancelling(true);
    try {
      const response = await fetch(`/api/payments/attempt?attempt=${encodeURIComponent(attemptId)}`, {
        method: 'DELETE',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'No se pudo cancelar el intento');
      stopped.current = true;
      window.location.replace('/planes');
    } catch (error) {
      setResult((current) => ({
        ...current,
        message: error.message || 'No se pudo cancelar todavia. Comprueba el estado antes de abrir otro pago.',
      }));
    } finally {
      setCancelling(false);
    }
  };

  useEffect(() => {
    stopped.current = false;
    void check();
    const timer = window.setInterval(() => {
      if (stopped.current) return;
      // Poll rapido durante 90 s y luego espaciado; nunca queda un spinner sin explicacion.
      const elapsed = Date.now() - startedAt.current;
      if (elapsed <= 90_000 || elapsed % 10_000 < 2_500) void check();
    }, 2_500);
    return () => {
      stopped.current = true;
      window.clearInterval(timer);
    };
  }, [check]);

  const success = result.status === 'succeeded';
  const failed = result.status === 'failed';
  const Icon = success ? CheckCircle2 : failed ? TriangleAlert : Clock3;

  return (
    <main className="payment-status-page">
      <section className={`payment-status-card is-${result.status}`}>
        <BrandLogoMedia className="payment-status-logo" />
        <div className="payment-status-icon"><Icon size={34} aria-hidden="true" /></div>
        <p className="payment-status-kicker"><ShieldCheck size={14} /> Verificacion segura</p>
        <h1>{success ? 'Pago confirmado' : failed ? 'El pago no fue aprobado' : 'Estamos confirmando tu pago'}</h1>
        <p>{result.message || (success ? 'Tu acceso ya esta activo.' : 'Consultando directamente con el proveedor…')}</p>

        {success && <span className="payment-status-note">Entrando a CF Analisis…</span>}
        {!success && !failed && (
          <>
            <button type="button" onClick={check} disabled={checking || cancelling} className="modal-btn">
              <RefreshCw size={16} className={checking ? 'is-spinning' : ''} />
              {checking ? 'Comprobando…' : 'Comprobar ahora'}
            </button>
            <button type="button" onClick={cancelAttempt} disabled={checking || cancelling} className="payment-status-cancel">
              {cancelling ? 'Cancelando de forma segura…' : 'Cancelar este intento y usar otro metodo'}
            </button>
          </>
        )}
        {failed && <Link href="/planes" className="modal-btn payment-status-link">Volver a intentar</Link>}
        <small>No cierres esta pantalla durante una autorizacion bancaria. Nunca debes pagar dos veces.</small>
      </section>
    </main>
  );
}
