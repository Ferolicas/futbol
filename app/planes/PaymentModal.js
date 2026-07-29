'use client';

import { useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { Check, LockKeyhole, ShieldCheck, X } from 'lucide-react';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);

const PLATFORM_LINES = [
  'Acceso total a estadísticas, análisis y herramientas',
  'Apuesta del día, combinadas y marcadores en vivo',
  '15+ ligas internacionales',
  'Cancela cuando quieras',
];

// Metadata por plan (periodo legible). El PRECIO NO se hardcodea: se inyecta
// desde displayAmount, que ya viene en la MONEDA LOCAL del cliente — así el
// label coincide con lo que ve y paga (ej. "6 EUR/semana"), sin USD fijo que
// confunda.
const PLAN_META = {
  semanal:    { title: 'Plan Semanal',    period: 'semanal',    per: 'semana',  cycle: 'cada 7 días' },
  mensual:    { title: 'Plan Mensual',    period: 'mensual',    per: 'mes',     cycle: 'cada mes' },
  trimestral: { title: 'Plan Trimestral', period: 'trimestral', per: '3 meses', cycle: 'cada 3 meses' },
  semestral:  { title: 'Plan Semestral',  period: 'semestral',  per: '6 meses', cycle: 'cada 6 meses' },
  anual:      { title: 'Plan Anual',      period: 'anual',      per: 'año',     cycle: 'cada 12 meses' },
};

function PaymentForm({ plan, displayAmount, onClose }) {
  const stripe = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const meta = PLAN_META[plan] || { title: 'Plan', period: '', per: 'periodo', cycle: 'cada periodo' };
  const conditionLines = [
    `Suscripción ${meta.period} — ${displayAmount}/${meta.per}`,
    `Cobro automático ${meta.cycle}`,
    ...PLATFORM_LINES,
  ];

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;

    setLoading(true);
    setError('');

    const returnUrl = `${window.location.origin}/dashboard?checkout=success&plan=${plan}`;

    const { error: stripeError } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
    });

    if (stripeError) {
      if (stripeError.type === 'card_error' || stripeError.type === 'validation_error') {
        setError(stripeError.message);
      } else {
        setError('Error al procesar el pago. Intenta de nuevo.');
      }
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="payment-modal-form">
      <button
        type="button"
        className="payment-modal-close"
        onClick={onClose}
        aria-label="Cerrar checkout"
      >
        <X size={19} aria-hidden="true" />
      </button>

      <div className="payment-modal-header">
        <video
          className="payment-modal-logo"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          aria-label="CF Análisis"
        >
          <source src="/logo-metalizado.webm" type="video/webm" />
        </video>
        <p className="payment-modal-eyebrow">
          <ShieldCheck size={14} aria-hidden="true" />
          Checkout seguro
        </p>
        <h2>{meta.title}</h2>
        <div className="payment-modal-summary">
          <span>Total de hoy</span>
          <strong>{displayAmount}</strong>
          <small>Renovación automática {meta.cycle}</small>
        </div>
      </div>

      <div className="payment-modal-conditions">
        <ul>
          {conditionLines.map((line, i) => (
            <li key={i}>
              <Check size={14} strokeWidth={2.5} aria-hidden="true" />
              {line}
            </li>
          ))}
        </ul>
      </div>

      {error && <div className="modal-error">{error}</div>}

      <div className="payment-modal-secure-line">
        <LockKeyhole size={15} aria-hidden="true" />
        Introduce tus datos de pago
      </div>

      <div className="payment-modal-element">
        <PaymentElement
          options={{
            layout: 'tabs',
            wallets: { applePay: 'auto', googlePay: 'auto' },
          }}
        />
      </div>

      <button
        type="submit"
        disabled={!stripe || loading}
        className="modal-btn payment-submit"
      >
        {loading ? 'Procesando pago…' : `Pagar ${displayAmount}`}
      </button>

      <p className="payment-modal-footnote">
        <ShieldCheck size={13} aria-hidden="true" />
        Pago procesado por Stripe. CF Análisis no almacena los datos de tu tarjeta.
      </p>
    </form>
  );
}

export default function PaymentModal({ clientSecret, plan, displayAmount, onClose }) {
  if (!clientSecret) return null;

  const appearance = {
    theme: 'night',
    variables: {
      colorPrimary: '#5ee6b1',
      colorBackground: '#09131b',
      colorText: '#eef7f4',
      colorTextSecondary: '#8fa1ad',
      colorDanger: '#fb7185',
      accessibleColorOnColorBackground: '#ffffff',
      borderRadius: '14px',
      fontFamily: 'inherit',
      // Iconos claros: con theme 'night' el icono de tarjeta salía negro sobre
      // fondo oscuro (invisible). Forzamos color claro en todos los iconos.
      colorIcon: '#d7e5e3',
      colorIconTab: '#a7b7bd',
      colorIconTabSelected: '#ffffff',
      colorIconTabHover: '#ffffff',
      tabIconColor: '#ffffff',
      tabIconHoverColor: '#ffffff',
      tabIconSelectedColor: '#ffffff',
      colorIconCardCvc: '#d7e5e3',
      colorIconCardError: '#fb7185',
      spacingUnit: '4px',
    },
    rules: {
      '.Label': { color: '#c4d2d4', fontWeight: '600', marginBottom: '7px' },
      '.Tab': {
        border: '1px solid rgba(255,255,255,.09)',
        backgroundColor: '#0b1720',
        boxShadow: 'none',
        color: '#ffffff',
      },
      '.Tab:hover': { borderColor: 'rgba(94,230,177,.38)', color: '#ffffff' },
      '.Tab--selected': {
        borderColor: '#5ee6b1',
        backgroundColor: '#10231f',
        boxShadow: '0 0 0 1px rgba(94,230,177,.12)',
        color: '#ffffff',
      },
      '.TabIcon': { fill: '#ffffff', color: '#ffffff' },
      '.TabIcon--selected': { fill: '#ffffff', color: '#ffffff' },
      '.Icon': { fill: '#d7e5e3' },
      '.Input': {
        border: '1px solid rgba(255,255,255,.1)',
        backgroundColor: '#0b1720',
        boxShadow: 'none',
        padding: '13px',
      },
      '.Input:hover': { borderColor: 'rgba(255,255,255,.2)' },
      '.Input:focus': {
        borderColor: '#5ee6b1',
        boxShadow: '0 0 0 3px rgba(94,230,177,.1)',
      },
    },
  };

  return (
    <div className="payment-modal-overlay" onClick={onClose}>
      <div className="payment-modal-content" onClick={(e) => e.stopPropagation()}>
        <Elements
          stripe={stripePromise}
          options={{ clientSecret, appearance }}
        >
          <PaymentForm
            plan={plan}
            displayAmount={displayAmount}
            onClose={onClose}
          />
        </Elements>
      </div>
    </div>
  );
}
