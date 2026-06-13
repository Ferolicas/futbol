'use client';

import { useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);

const PLATFORM_LINES = [
  'Acceso total a estadisticas, analisis y herramientas',
  'Apuesta del Dia, combinadas y marcadores en vivo',
  '15+ ligas internacionales',
  'Cancela cuando quieras',
];

// Metadata por plan (periodo legible). El PRECIO NO se hardcodea: se inyecta
// desde displayAmount, que ya viene en la MONEDA LOCAL del cliente — así el
// label coincide con lo que ve y paga (ej. "6 EUR/semana"), sin USD fijo que
// confunda.
const PLAN_META = {
  semanal:    { title: 'Plan Semanal',    period: 'semanal',    per: 'semana',  cycle: 'cada 7 dias' },
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
    `Suscripcion ${meta.period} — ${displayAmount}/${meta.per}`,
    `Cobro automatico ${meta.cycle}`,
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
      <div className="payment-modal-header">
        <button type="button" className="payment-modal-close" onClick={onClose}>&times;</button>
        <img src="/vflogo.png" alt="CFanalisis" className="payment-modal-logo" />
        <h2>{meta.title}</h2>
        <p className="payment-modal-amount">{displayAmount}</p>
      </div>

      <div className="payment-modal-conditions">
        <ul>
          {conditionLines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </div>

      {error && <div className="modal-error">{error}</div>}

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
        className="modal-btn"
      >
        {loading ? 'Procesando...' : `Pagar ${displayAmount}`}
      </button>
    </form>
  );
}

export default function PaymentModal({ clientSecret, plan, displayAmount, onClose }) {
  if (!clientSecret) return null;

  const appearance = {
    theme: 'night',
    variables: {
      colorPrimary: '#00e676',
      colorBackground: '#0d0d14',
      colorText: '#e8e8ef',
      colorTextSecondary: '#8888a4',
      colorDanger: '#ff3d57',
      borderRadius: '10px',
      fontFamily: 'inherit',
      // Iconos claros: con theme 'night' el icono de tarjeta salía negro sobre
      // fondo oscuro (invisible). Forzamos color claro en todos los iconos.
      colorIcon: '#e8e8ef',
      colorIconTab: '#cfcfe0',
      colorIconTabSelected: '#06060b',
      colorIconTabHover: '#ffffff',
      colorIconCardCvc: '#e8e8ef',
      colorIconCardError: '#ff3d57',
    },
    rules: {
      '.Tab': { border: '1px solid #1e1e2e', backgroundColor: '#12121c' },
      '.Tab--selected': { borderColor: '#00e676', backgroundColor: '#0d0d14' },
      '.TabIcon': { fill: '#e8e8ef' },
      '.TabIcon--selected': { fill: '#06060b' },
      '.Icon': { fill: '#e8e8ef' },
      '.Input': { border: '1px solid #1e1e2e', backgroundColor: '#12121c' },
      '.Input:focus': { borderColor: '#00e676' },
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
