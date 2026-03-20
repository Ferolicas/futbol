'use client';

import { useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);

const PLAN_CONDITIONS = {
  plataforma: {
    title: 'Plan Plataforma',
    lines: [
      'Suscripcion mensual',
      'Primer mes: $15 USD (50% de descuento)',
      'A partir del segundo mes: $30 USD/mes',
      'Acceso total a estadisticas, analisis y herramientas',
      'Cancela cuando quieras',
    ],
  },
  asesoria: {
    title: 'Plan Asesoria',
    lines: [
      'Pago unico de $100 USD',
      '1 mes de asesoria personalizada + acceso a plataforma',
      'Formacion en apuestas, estrategias y bankroll',
      'Soporte prioritario 1 a 1',
      'Luego: $15 USD el segundo mes, $30 USD/mes en adelante',
    ],
  },
};

function PaymentForm({ plan, amount, onClose }) {
  const stripe = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const conditions = PLAN_CONDITIONS[plan];

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

  const displayAmount = (amount / 100).toFixed(0);

  return (
    <form onSubmit={handleSubmit} className="payment-modal-form">
      <div className="payment-modal-header">
        <button type="button" className="payment-modal-close" onClick={onClose}>&times;</button>
        <img src="/vflogo.png" alt="CFanalisis" className="payment-modal-logo" />
        <h2>{conditions.title}</h2>
        <p className="payment-modal-amount">${displayAmount} USD</p>
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
        {loading ? 'Procesando...' : `Pagar $${displayAmount} USD`}
      </button>
    </form>
  );
}

export default function PaymentModal({ clientSecret, plan, amount, onClose }) {
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
            amount={amount}
            onClose={onClose}
          />
        </Elements>
      </div>
    </div>
  );
}
