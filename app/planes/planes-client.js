'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
const supabaseBrowser = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
import { motion } from 'framer-motion';
import PaymentModal from './PaymentModal';

// Orden, etiquetas y badges de los 5 planes (claves IDs en lib/stripe.js)
const PLAN_ORDER = [
  { id: 'semanal',    badge: null,           perLabel: '/ semana' },
  { id: 'mensual',    badge: 'Popular',      perLabel: '/ mes' },
  { id: 'trimestral', badge: null,           perLabel: '/ 3 meses' },
  { id: 'semestral',  badge: 'Mejor precio', perLabel: '/ 6 meses' },
  { id: 'anual',      badge: 'VIP',          perLabel: '/ año' },
];

const PLATFORM_DESCRIPTION = 'Acceso total a estadisticas, analisis y herramientas de apuesta';
const PLATFORM_FEATURES = [
  'Analisis estadistico completo',
  'Apuesta del Dia inteligente',
  'Combinadas automaticas',
  'Marcadores en vivo',
  '15+ ligas internacionales',
  'Corners, tarjetas, BTTS',
];

export default function PlanesClient({ userId, email }) {
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [prices, setPrices] = useState(null);
  const [pricesLoading, setPricesLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [paymentData, setPaymentData] = useState(null);

  useEffect(() => {
    fetch('/api/detect-country')
      .then(r => r.json())
      .then(data => {
        if (data.countryCode) {
          return fetch(`/api/currency?country=${data.countryCode}`)
            .then(r => r.json())
            .then(setPrices);
        }
      })
      .catch(() => {})
      .finally(() => setPricesLoading(false));
  }, []);

  const handleSelectPlan = async (plan) => {
    setSelectedPlan(plan);
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, email, currency: prices?.currency || 'USD' }),
      });
      const data = await res.json();

      if (data.clientSecret) {
        const localDisplay = fmtPrice(plan);
        setPaymentData({
          clientSecret: data.clientSecret,
          plan: data.plan,
          displayAmount: localDisplay,
        });
      } else {
        setError(data.error || 'Error al procesar pago');
      }
    } catch {
      setError('Error de conexion');
    } finally {
      setLoading(false);
    }
  };

  const handleClosePayment = () => {
    setPaymentData(null);
    setSelectedPlan(null);
  };

  const fmtPrice = (planId) => {
    if (pricesLoading) return '...';
    const p = prices?.plans?.[planId];
    if (p?.fixedCurrency) {
      const sym = p.nativeCurrency === 'EUR' ? '€' : p.nativeCurrency === 'USD' ? '$' : '';
      return `${sym}${p.nativeAmount} ${p.nativeCurrency}`;
    }
    const local = p?.local;
    const currency = p?.currency;
    const fallback = p?.nativeAmount ?? p?.usd;
    if (!local || !currency || currency === 'USD') return `$${fallback} USD`;
    return `${Math.round(local).toLocaleString()} ${currency}`;
  };

  const fmtOriginal = (planId) => {
    const p = prices?.plans?.[planId];
    if (!p?.originalAmount) return null;
    const sym = p.nativeCurrency === 'EUR' ? '€' : p.nativeCurrency === 'USD' ? '$' : '';
    return `${sym}${p.originalAmount}`;
  };

  return (
    <div className="planes-page">
      <div className="planes-bg" />
      <motion.div
        className="planes-container"
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <motion.div
          className="planes-header"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
        >
          <img src="/vflogo.png" alt="CFanalisis" className="planes-logo" />
          <h1>Selecciona tu plan</h1>
          <p>Para acceder al panel de analisis necesitas un plan activo</p>
        </motion.div>

        {error && <div className="modal-error">{error}</div>}

        <div className="pricing-grid">
          {PLAN_ORDER.map((plan, idx) => {
            const isSelected = selectedPlan === plan.id;
            const isPremium = plan.badge === 'VIP';
            const original = fmtOriginal(plan.id);
            return (
              <motion.div
                key={plan.id}
                className={`plan-card ${isPremium ? 'premium' : ''} ${isSelected ? 'selected' : ''}`}
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 + idx * 0.08, duration: 0.5 }}
                whileHover={{ scale: 1.02 }}
                onClick={() => !loading && handleSelectPlan(plan.id)}
                style={{ cursor: loading ? 'wait' : 'pointer' }}
              >
                {plan.badge && (
                  <div className={`plan-badge ${isPremium ? 'premium' : ''}`}>{plan.badge}</div>
                )}
                <h3 className="plan-name">{`Plan ${plan.id.charAt(0).toUpperCase() + plan.id.slice(1)}`}</h3>
                <p className="plan-desc">{PLATFORM_DESCRIPTION}</p>
                <div className="plan-price">
                  {original && (
                    <span className="plan-amount-original" style={{ textDecoration: 'line-through', opacity: 0.55, marginRight: 8, fontSize: '0.7em' }}>{original}</span>
                  )}
                  <span className="plan-amount">{fmtPrice(plan.id)}</span>
                  <span className="plan-period">{plan.perLabel}</span>
                </div>
                <div className="plan-after">Cobro automatico cada periodo, cancela cuando quieras</div>
                <ul className="plan-features">
                  {PLATFORM_FEATURES.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                {loading && isSelected && (
                  <div className="modal-loading">Preparando pago...</div>
                )}
              </motion.div>
            );
          })}
        </div>

        <div className="planes-footer">
          <button
            className="planes-signout"
            onClick={() => supabaseBrowser.auth.signOut().then(() => window.location.href = '/')}
          >
            Cerrar sesion
          </button>
        </div>
      </motion.div>

      {paymentData && (
        <PaymentModal
          clientSecret={paymentData.clientSecret}
          plan={paymentData.plan}
          displayAmount={paymentData.displayAmount}
          onClose={handleClosePayment}
        />
      )}
    </div>
  );
}
