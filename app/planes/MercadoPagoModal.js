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
  }).catch((error) => {
    mpSdkPromise = null;
    throw error;
  });
  return mpSdkPromise;
}

const CONTAINER_ID = 'mp-payment-brick-container';

// Modal de pago con Mercado Pago — PAYMENT BRICK: muestra TODOS los métodos
// (tarjeta, PSE/Nequi, Efecty…) embebidos sobre la web. Al enviar:
//   - Tarjeta → suscripción recurrente (preapproval), activa sin salir del sitio.
//   - PSE/Efecty → pago del periodo; MP devuelve la URL del banco y redirigimos
//     SOLO en ese caso (es inevitable en esos métodos).
export default function MercadoPagoModal({
  plan,
  planLabel,
  amountCop,
  email,
  payerName,
  publicKey,
  attemptId,
  country,
  onClose,
}) {
  const [error, setError] = useState('');
  const [phase, setPhase] = useState('loading'); // loading | ready | processing
  const nameParts = String(payerName || '').trim().split(/\s+/).filter(Boolean);
  const initialBillingDetails = {
    firstName: nameParts[0] || '',
    lastName: nameParts.slice(1).join(' '),
    zipCode: '',
    streetName: '',
    streetNumber: '',
    neighborhood: '',
    city: '',
    phoneAreaCode: '',
    phoneNumber: '',
  };
  const [billingDetails, setBillingDetails] = useState(initialBillingDetails);
  const billingDetailsRef = useRef(initialBillingDetails);
  const controllerRef = useRef(null);
  const pseDetailsRef = useRef(null);
  const attemptRef = useRef(attemptId);

  const freshAttempt = () => {
    attemptRef.current = globalThis.crypto?.randomUUID?.() || attemptRef.current;
  };

  const setBillingField = (field) => (event) => {
    setBillingDetails((current) => {
      const next = { ...current, [field]: event.target.value };
      billingDetailsRef.current = next;
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    let creationAbandoned = false;
    (async () => {
      try {
        const MercadoPago = await Promise.race([
          loadMpSdk(),
          new Promise((_, reject) => window.setTimeout(() => reject(new Error('MP_SDK_TIMEOUT')), 15_000)),
        ]);
        if (cancelled || !MercadoPago) return;
        if (!publicKey) {
          setError('Falta configurar Mercado Pago.');
          setPhase('ready');
          return;
        }

        const mp = new MercadoPago(publicKey, { locale: 'es-CO' });
        const builder = mp.bricks();
        const creation = Promise.resolve(builder.create('payment', CONTAINER_ID, {
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
              if (!cancelled) {
                setError('No se pudo cargar el formulario de pago.');
                setPhase('ready');
              }
            },
            onSubmit: ({ selectedPaymentMethod, formData }) => {
              setPhase('processing');
              setError('');
              return fetch('/api/mercadopago/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  plan,
                  attemptId: attemptRef.current,
                  selectedPaymentMethod,
                  formData,
                  billingDetails: billingDetailsRef.current,
                  country,
                }),
                signal: AbortSignal.timeout(30_000),
              })
                .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
                .then(({ ok, data }) => {
                  if (data.attemptId) attemptRef.current = data.attemptId;
                  if (ok && data.redirectUrl) {
                    // PSE/Efecty → redirige al banco/instrucciones de pago.
                    window.location.href = data.redirectUrl;
                    return;
                  }
                  if (ok && data.ok) {
                    window.location.href = data.statusUrl || `/pago/estado?attempt=${encodeURIComponent(data.attemptId || attemptRef.current)}`;
                    return;
                  }
                  if (data.code === 'PAYMENT_IN_PROGRESS' && data.attemptId) {
                    window.location.href = `/pago/estado?attempt=${encodeURIComponent(data.attemptId)}`;
                    return;
                  }
                  if (data.code === 'PSE_BILLING_REQUIRED' && pseDetailsRef.current) {
                    pseDetailsRef.current.open = true;
                  }
                  if (data.code === 'PAYMENT_REJECTED' || data.code === 'ATTEMPT_EXPIRED') freshAttempt();
                  setError(data.error || 'No se pudo procesar el pago.');
                  setPhase('ready');
                  const failure = new Error('payment_failed');
                  failure.handled = true;
                  throw failure;
                })
                .catch((e) => {
                  if (!e.handled) {
                    setError(e?.name === 'TimeoutError'
                      ? 'Mercado Pago tardo en responder. Reintenta: usaremos la misma operacion sin duplicar el cobro.'
                      : 'Error de conexion. Reintenta sin riesgo de doble cobro.');
                    setPhase('ready');
                  }
                  throw e;
                });
            },
          },
        }));
        creation.then((controller) => {
          if (cancelled || creationAbandoned) controller?.unmount?.();
        }).catch(() => {});
        const controller = await Promise.race([
          creation,
          new Promise((_, reject) => window.setTimeout(
            () => reject(new Error('MP_BRICK_TIMEOUT')),
            20_000,
          )),
        ]);
        if (cancelled) {
          controller?.unmount?.();
          return;
        }
        controllerRef.current = controller;
      } catch (e) {
        creationAbandoned = true;
        console.error(e);
        if (!cancelled) {
          setError('No se pudo iniciar Mercado Pago. Cierra y vuelve a intentarlo.');
          setPhase('ready');
        }
      }
    })();
    return () => {
      cancelled = true;
      try { controllerRef.current?.unmount?.(); } catch {}
      controllerRef.current = null;
    };
  }, [plan, amountCop, email, publicKey, country]);

  return (
    <div className="payment-modal-overlay">
      <div
        className="payment-modal-content mp-payment-modal-content"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="payment-modal-close"
          onClick={() => onClose(attemptRef.current)}
          disabled={phase === 'processing'}
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

        <details className="mp-pse-details" ref={pseDetailsRef}>
          <summary>¿Pagaras con PSE? Completa tus datos reales</summary>
          <p>Mercado Pago exige estos datos para enviarte al banco. Con tarjeta puedes omitirlos.</p>
          <div className="mp-pse-grid">
            <label>Nombre<input value={billingDetails.firstName} maxLength={32} onChange={setBillingField('firstName')} autoComplete="given-name" /></label>
            <label>Apellido<input value={billingDetails.lastName} maxLength={32} onChange={setBillingField('lastName')} autoComplete="family-name" /></label>
            <label>Codigo postal<input value={billingDetails.zipCode} maxLength={5} inputMode="numeric" pattern="[0-9]{5}" onChange={setBillingField('zipCode')} autoComplete="postal-code" /></label>
            <label>Ciudad<input value={billingDetails.city} maxLength={18} onChange={setBillingField('city')} autoComplete="address-level2" /></label>
            <label>Calle<input value={billingDetails.streetName} maxLength={18} onChange={setBillingField('streetName')} autoComplete="address-line1" /></label>
            <label>Numero<input value={billingDetails.streetNumber} maxLength={5} onChange={setBillingField('streetNumber')} /></label>
            <label>Barrio<input value={billingDetails.neighborhood} maxLength={18} onChange={setBillingField('neighborhood')} autoComplete="address-level3" /></label>
            <div className="mp-pse-phone">
              <label>Indicativo<input value={billingDetails.phoneAreaCode} maxLength={3} inputMode="numeric" onChange={setBillingField('phoneAreaCode')} placeholder="601" /></label>
              <label>Telefono<input value={billingDetails.phoneNumber} maxLength={5} inputMode="numeric" onChange={setBillingField('phoneNumber')} autoComplete="tel-national" /></label>
            </div>
          </div>
        </details>

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
            Enviando de forma segura…
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
