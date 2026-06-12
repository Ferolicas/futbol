'use client';

import { useEffect, useRef, useState } from 'react';

// Carga el SDK de Mercado Pago (v2) una sola vez.
let mpSdkPromise = null;
function loadMpSdk() {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.MercadoPago) return Promise.resolve(window.MercadoPago);
  if (mpSdkPromise) return mpSdkPromise;
  mpSdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://sdk.mercadopago.com/js/v2';
    s.onload = () => resolve(window.MercadoPago);
    s.onerror = () => reject(new Error('No se pudo cargar Mercado Pago'));
    document.head.appendChild(s);
  });
  return mpSdkPromise;
}

const CONTAINER_ID = 'mp-card-brick-container';

// Modal de pago con Mercado Pago — formulario de TARJETA embebido (Card Brick),
// SIN redirigir. Al enviar, tokeniza la tarjeta y crea la suscripción recurrente
// (preapproval) vía /api/mercadopago/subscribe. Mismo patrón de modal que Stripe.
export default function MercadoPagoModal({ plan, planLabel, amountCop, email, publicKey, onClose }) {
  const [error, setError] = useState('');
  const [phase, setPhase] = useState('loading'); // loading | ready | processing | done
  const controllerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const MercadoPago = await loadMpSdk();
        if (cancelled || !MercadoPago) return;
        if (!publicKey) { setError('Falta configurar Mercado Pago.'); return; }

        const mp = new MercadoPago(publicKey, { locale: 'es-CO' });
        const builder = mp.bricks();
        controllerRef.current = await builder.create('cardPayment', CONTAINER_ID, {
          initialization: {
            amount: amountCop,
            payer: { email: email || '' },
          },
          customization: {
            visual: { style: { theme: 'dark' } },
            paymentMethods: { maxInstallments: 1 }, // suscripción → sin cuotas
          },
          callbacks: {
            onReady: () => { if (!cancelled) setPhase('ready'); },
            onError: (e) => {
              console.error('[mp-brick]', e);
              if (!cancelled) setError('No se pudo cargar el formulario de pago.');
            },
            onSubmit: async (formData) => {
              setPhase('processing');
              setError('');
              try {
                const res = await fetch('/api/mercadopago/subscribe', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    plan,
                    cardToken: formData.token,
                    paymentMethodId: formData.payment_method_id,
                  }),
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok && data.ok) {
                  setPhase('done');
                  window.location.href = '/dashboard';
                } else {
                  setError(data.error || 'No se pudo procesar el pago.');
                  setPhase('ready');
                }
              } catch {
                setError('Error de conexión. Intenta de nuevo.');
                setPhase('ready');
              }
            },
          },
        });
      } catch (e) {
        console.error(e);
        if (!cancelled) setError('No se pudo iniciar Mercado Pago.');
      }
    })();
    return () => {
      cancelled = true;
      try { controllerRef.current?.unmount?.(); } catch {}
    };
  }, [plan, amountCop, email, publicKey]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#0f1722', borderRadius: 16, padding: 24,
          width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,.5)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.15rem' }}>{planLabel || `Plan ${plan}`}</h2>
            <p style={{ margin: '4px 0 0', opacity: .85 }}>
              {amountCop ? `${Math.round(amountCop).toLocaleString('es-CO')} COP` : ''} · renovación automática
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, cursor: 'pointer', lineHeight: 1 }}
          >
            &times;
          </button>
        </div>

        {error && (
          <div className="modal-error" style={{ margin: '8px 0', color: '#ff6b6b', fontSize: '.9rem' }}>{error}</div>
        )}
        {phase === 'loading' && <div style={{ padding: '20px 0', textAlign: 'center', opacity: .8 }}>Cargando pago seguro…</div>}

        <div id={CONTAINER_ID} />

        {phase === 'processing' && (
          <div style={{ padding: '12px 0', textAlign: 'center', opacity: .9 }}>Procesando…</div>
        )}
      </div>
    </div>
  );
}
