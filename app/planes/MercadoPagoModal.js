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
    federalUnit: '',
    phoneAreaCode: '',
    phoneNumber: '',
  };
  const [billingDetails, setBillingDetails] = useState(initialBillingDetails);
  const [invalidFields, setInvalidFields] = useState({});
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
    setInvalidFields((current) => (current[field] ? { ...current, [field]: false } : current));
  };

  // Los datos de PSE viven en un desplegable: al rechazarlos hay que abrirlo,
  // llevar la vista hasta el y marcar exactamente que campo falta.
  const revealBillingErrors = (fields) => {
    setInvalidFields(
      Object.fromEntries(Object.keys(fields || {}).map((field) => [field, true])),
    );
    const panel = pseDetailsRef.current;
    if (!panel) return;
    panel.open = true;
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const billingInput = (field, props = {}) => ({
    value: billingDetails[field],
    onChange: setBillingField(field),
    'aria-invalid': invalidFields[field] ? 'true' : undefined,
    className: invalidFields[field] ? 'mp-pse-input-error' : undefined,
    ...props,
  });

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
                  if (data.code === 'PSE_BILLING_REQUIRED') {
                    revealBillingErrors(data.fields);
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
            <small>Tarjeta, PSE (Nequi y DaviPlata incluidos) o efectivo</small>
          </div>
        </header>

        {error && (
          <div className="modal-error" role="alert">{error}</div>
        )}

        <div className="payment-modal-secure-line">
          <WalletCards size={16} aria-hidden="true" />
          Elige tu método de pago
        </div>

        <details className="mp-pse-details" ref={pseDetailsRef} open>
          <summary>Datos obligatorios para pagar con PSE, Nequi o DaviPlata</summary>
          <p>
            Nequi y DaviPlata se pagan desde <strong>PSE</strong>: mas abajo elige
            &laquo;Transferencia con PSE&raquo; y seleccionalos en la lista de bancos. PSE no
            crea el pago sin estos datos, asi que completalos antes de darle a Pagar.
            <strong> Si pagas con tarjeta o en efectivo, ignora esta seccion.</strong>
          </p>
          <div className="mp-pse-grid">
            <label>Nombre<input {...billingInput('firstName', { maxLength: 32, autoComplete: 'given-name' })} /></label>
            <label>Apellido<input {...billingInput('lastName', { maxLength: 32, autoComplete: 'family-name' })} /></label>
            <label>Codigo postal<input {...billingInput('zipCode', { maxLength: 5, inputMode: 'numeric', pattern: '[0-9]{5}', autoComplete: 'postal-code', placeholder: '11001' })} /></label>
            <label>Ciudad<input {...billingInput('city', { maxLength: 18, autoComplete: 'address-level2' })} /></label>
            <label>Departamento<input {...billingInput('federalUnit', { maxLength: 18, autoComplete: 'address-level1', placeholder: 'Cundinamarca' })} /></label>
            <label>Calle<input {...billingInput('streetName', { maxLength: 18, autoComplete: 'address-line1' })} /></label>
            <label>Numero<input {...billingInput('streetNumber', { maxLength: 5 })} /></label>
            <label>Barrio<input {...billingInput('neighborhood', { maxLength: 18, autoComplete: 'address-level3' })} /></label>
            <div className="mp-pse-phone">
              <label>Indicativo<input {...billingInput('phoneAreaCode', { maxLength: 3, inputMode: 'numeric', placeholder: '601' })} /></label>
              <label>Telefono<input {...billingInput('phoneNumber', { maxLength: 7, inputMode: 'numeric', autoComplete: 'tel-national', placeholder: '1234567' })} /></label>
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
