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

const PLAN_CONDITIONS = {
  semanal: {
    title: 'Plan Semanal',
    lines: ['Suscripcion semanal — $7 USD/semana', 'Cobro automatico cada 7 dias', ...PLATFORM_LINES],
  },
  mensual: {
    title: 'Plan Mensual',
    lines: ['Suscripcion mensual — $15 USD/mes', 'Cobro automatico cada mes', ...PLATFORM_LINES],
  },
  trimestral: {
    title: 'Plan Trimestral',
    lines: ['Suscripcion trimestral — $35 USD cada 3 meses', 'Cobro automatico cada 3 meses', ...PLATFORM_LINES],
  },
  semestral: {
    title: 'Plan Semestral',
    lines: ['Suscripcion semestral — $80 USD cada 6 meses', 'Cobro automatico cada 6 meses', ...PLATFORM_LINES],
  },
  anual: {
    title: 'Plan Anual',
    lines: ['Suscripcion anual — €100 EUR/año (antes €120, ahorras €20)', 'Cobro automatico cada 12 meses', ...PLATFORM_LINES],
  },
};

function PaymentForm({ plan, displayAmount, onClose }) {
  const stripe = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const conditions = PLAN_CONDITIONS[plan] || { title: 'Plan', lines: PLATFORM_LINES };

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
        <h2>{conditions.title}</h2>
        <p className="payment-modal-amount">{displayAmount}</p>
      </div>

      <div className="payment-modal-conditions">
        <ul>
          {conditions.lines.map((line, i) => (
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
    },
    rules: {
      '.Tab': { border: '1px solid #1e1e2e', backgroundColor: '#12121c' },
      '.Tab--selected': { borderColor: '#00e676', backgroundColor: '#0d0d14' },
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
