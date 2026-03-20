'use client';

import { useState, useEffect } from 'react';
import { useClerk } from '@clerk/nextjs';
import { motion } from 'framer-motion';
import PaymentModal from './PaymentModal';

export default function PlanesClient({ userId, email }) {
  const { signOut } = useClerk();
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [prices, setPrices] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [paymentData, setPaymentData] = useState(null);

  // Detect country and get prices
  useEffect(() => {
    fetch('https://ipapi.co/json/')
      .then(r => r.json())
      .then(data => {
        if (data.country_code) {
          fetch(`/api/currency?country=${data.country_code}`)
            .then(r => r.json())
            .then(setPrices)
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  const handleSelectPlan = async (plan) => {
    setSelectedPlan(plan);
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, email }),
      });
      const data = await res.json();

      if (data.clientSecret) {
        setPaymentData({
          clientSecret: data.clientSecret,
          plan: data.plan,
          amount: data.amount,
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

  const fmtPrice = (usd, local, currency) => {
    if (!local || currency === 'USD') return `$${usd} USD`;
    return `$${usd} USD (~${currency} ${local.toLocaleString()})`;
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
          {/* Plan 1: Plataforma */}
          <motion.div
            className={`plan-card ${selectedPlan === 'plataforma' ? 'selected' : ''}`}
            initial={{ opacity: 0, x: -30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3, duration: 0.5 }}
            whileHover={{ scale: 1.02 }}
            onClick={() => !loading && handleSelectPlan('plataforma')}
            style={{ cursor: loading ? 'wait' : 'pointer' }}
          >
            <div className="plan-badge">Popular</div>
            <h3 className="plan-name">Plan Plataforma</h3>
            <p className="plan-desc">Acceso total a estadisticas, analisis y herramientas de apuesta</p>
            <div className="plan-price">
              <span className="plan-amount">
                {fmtPrice(15, prices?.plans?.plataforma?.firstMonth?.local, prices?.currency)}
              </span>
              <span className="plan-period">primer mes (50% dto.)</span>
            </div>
            <div className="plan-after">
              Luego {fmtPrice(30, prices?.plans?.plataforma?.regular?.local, prices?.currency)}/mes
            </div>
            <ul className="plan-features">
              <li>Analisis estadistico completo</li>
              <li>Apuesta del Dia inteligente</li>
              <li>Combinadas automaticas</li>
              <li>Marcadores en vivo</li>
              <li>15+ ligas internacionales</li>
              <li>Corners, tarjetas, BTTS</li>
            </ul>
            {loading && selectedPlan === 'plataforma' && (
              <div className="modal-loading">Preparando pago...</div>
            )}
          </motion.div>

          {/* Plan 2: Asesoria */}
          <motion.div
            className={`plan-card premium ${selectedPlan === 'asesoria' ? 'selected' : ''}`}
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.4, duration: 0.5 }}
            whileHover={{ scale: 1.02 }}
            onClick={() => !loading && handleSelectPlan('asesoria')}
            style={{ cursor: loading ? 'wait' : 'pointer' }}
          >
            <div className="plan-badge premium">VIP</div>
            <h3 className="plan-name">Plan Asesoria</h3>
            <p className="plan-desc">Formacion en apuestas, estrategias, bankroll + acceso total a plataforma</p>
            <div className="plan-price">
              <span className="plan-amount">
                {fmtPrice(100, prices?.plans?.asesoria?.initial?.local, prices?.currency)}
              </span>
              <span className="plan-period">pago inicial (1 mes asesoria + plataforma)</span>
            </div>
            <div className="plan-after">
              Mes 2: {fmtPrice(15, prices?.plans?.asesoria?.secondMonth?.local, prices?.currency)} (50% dto.) &bull;
              Mes 3+: {fmtPrice(30, prices?.plans?.asesoria?.regular?.local, prices?.currency)}/mes
            </div>
            <ul className="plan-features">
              <li>Todo lo del Plan Plataforma</li>
              <li>Formacion personalizada en apuestas</li>
              <li>Estrategias de bankroll management</li>
              <li>Soporte prioritario 1 a 1</li>
              <li>Sesiones de asesoria mensual</li>
              <li>Acceso a comunidad VIP</li>
            </ul>
            {loading && selectedPlan === 'asesoria' && (
              <div className="modal-loading">Preparando pago...</div>
            )}
          </motion.div>
        </div>

        <div className="planes-footer">
          <button
            className="planes-signout"
            onClick={() => signOut({ redirectUrl: '/' })}
          >
            Cerrar sesion
          </button>
        </div>
      </motion.div>

      {paymentData && (
        <PaymentModal
          clientSecret={paymentData.clientSecret}
          plan={paymentData.plan}
          amount={paymentData.amount}
          onClose={handleClosePayment}
        />
      )}
    </div>
  );
}
