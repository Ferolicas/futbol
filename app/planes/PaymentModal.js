'use client';

import { useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);

function PaymentForm({ plan, amount, onSuccess, onClose }) {
  const stripe = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;

    setLoading(true);
    setError('');

    const returnUrl = `${window.location.origin}/dashboard?checkout=success&plan=${plan}`;

    const { error: stripeError } = plan === 'plataforma'
      ? await stripe.confirmPayment({ elements, confirmParams: { return_url: returnUrl } })
      : await stripe.confirmPayment({ elements, confirmParams: { return_url: returnUrl } });

    if (stripeError) {
      if (stripeError.type === 'card_error' || stripeError.type === 'validation_error') {
        setError(stripeError.message);
      } else {
        setError('Error al procesar el pago. Intenta de nuevo.');
      }
      setLoading(false);
    }
    // If no error, stripe redirects to return_url after successful payment
  };

  const displayAmount = (amount / 100).toFixed(2);

  return (
    <form onSubmit={handleSubmit} className="payment-modal-form">
      <div className="payment-modal-header">
        <img src="/vflogo.png" alt="CFanalisis" className="payment-modal-logo" />
        <h2>Completar pago</h2>
        <p className="payment-modal-amount">${displayAmount} USD</p>
        <button type="button" className="payment-modal-close" onClick={onClose}>&times;</button>
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
          options={{
            clientSecret,
            appearance,
          }}
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
