'use client';

import { useEffect, useRef, useState } from 'react';
import { LockKeyhole, ShieldCheck, WalletCards, X } from 'lucide-react';
import BrandLogoMedia from '../../components/BrandLogoMedia';

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

const CONTAINER_ID = 'mp-payment-brick-container';

// Modal de pago con Mercado Pago — PAYMENT BRICK: muestra TODOS los métodos
// (tarjeta, PSE/Nequi, Efecty…) embebidos sobre la web. Al enviar:
//   - Tarjeta → suscripción recurrente (preapproval), activa sin salir del sitio.
//   - PSE/Efecty → pago del periodo; MP devuelve la URL del banco y redirigimos
//     SOLO en ese caso (es inevitable en esos métodos).
export default function MercadoPagoModal({ plan, planLabel, amountCop, email, publicKey, onClose }) {
  const [error, setError] = useState('');
  const [phase, setPhase] = useState('loading'); // loading | ready | processing
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
        controllerRef.current = await builder.create('payment', CONTAINER_ID, {
          initialization: {
            amount: amountCop,
            payer: { email: email || '' },
          },
          customization: {
            visual: { style: { theme: 'dark' } },
            paymentMethods: {
              creditCard: 'all',
              debitCard: 'all',
              bankTransfer: 'all', // PSE / Nequi
              ticket: 'all',       // Efecty
              maxInstallments: 1,  // suscripción → sin cuotas
            },
          },
          callbacks: {
            onReady: () => { if (!cancelled) setPhase('ready'); },
            onError: (e) => {
              console.error('[mp-brick]', e);
              if (!cancelled) setError('No se pudo cargar el formulario de pago.');
            },
            onSubmit: ({ selectedPaymentMethod, formData }) => {
              setPhase('processing');
              setError('');
              return fetch('/api/mercadopago/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plan, selectedPaymentMethod, formData }),
              })
                .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
                .then(({ ok, data }) => {
                  if (ok && data.redirectUrl) {
                    // PSE/Efecty → redirige al banco/instrucciones de pago.
                    window.location.href = data.redirectUrl;
                    return;
                  }
                  if (ok && data.ok) {
                    // Tarjeta → suscripción activa, sin redirigir.
                    window.location.href = '/dashboard';
                    return;
                  }
                  setError(data.error || 'No se pudo procesar el pago.');
                  setPhase('ready');
                  throw new Error(data.error || 'payment_failed');
                })
                .catch((e) => {
                  if (!/payment_failed/.test(e.message)) {
                    setError('Error de conexión. Intenta de nuevo.');
                    setPhase('ready');
                  }
                  throw e;
                });
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
    <div className="payment-modal-overlay" onClick={onClose}>
      <div
        className="payment-modal-content mp-payment-modal-content"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="payment-modal-close"
          onClick={onClose}
          aria-label="Cerrar checkout"
        >
          <X size={19} aria-hidden="true" />
        </button>

        <header className="payment-modal-header">
          <BrandLogoMedia
            className="payment-modal-logo"
          />
          <p className="payment-modal-eyebrow">
            <ShieldCheck size={14} aria-hidden="true" />
            Checkout seguro en Colombia
          </p>
          <h2>{planLabel || `Plan ${plan}`}</h2>
          <div className="payment-modal-summary">
            <span>Total de hoy</span>
            <strong>
              {amountCop ? `${Math.round(amountCop).toLocaleString('es-CO')} COP` : ''}
            </strong>
            <small>Selecciona tarjeta, PSE, Nequi o efectivo</small>
          </div>
        </header>

        {error && (
          <div className="modal-error" role="alert">{error}</div>
        )}

        <div className="payment-modal-secure-line">
          <WalletCards size={16} aria-hidden="true" />
          Elige tu método de pago
        </div>

        {phase === 'loading' && (
          <div className="payment-modal-loading">
            <span className="payment-spinner" aria-hidden="true" />
            Cargando pago seguro…
          </div>
        )}

        <div id={CONTAINER_ID} className="mp-payment-brick" />

        {phase === 'processing' && (
          <div className="payment-modal-processing">
            <span className="payment-spinner" aria-hidden="true" />
            Procesando pago…
          </div>
        )}

        <p className="payment-modal-footnote">
          <LockKeyhole size={13} aria-hidden="true" />
          Pago procesado por Mercado Pago. Tus datos financieros permanecen protegidos.
        </p>
      </div>
    </div>
  );
}
