'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Globe2,
  LockKeyhole,
  LogOut,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import BrandLogoMedia from '../../components/BrandLogoMedia';
import MercadoPagoModal from './MercadoPagoModal';
import PaymentModal from './PaymentModal';

// Orden, etiquetas y badges de los 5 planes (claves IDs en lib/stripe.js)
const PLAN_ORDER = [
  { id: 'semanal',    name: 'Semanal',    duration: '7 días',   badge: null,           perLabel: '/ semana' },
  { id: 'mensual',    name: 'Mensual',    duration: '1 mes',    badge: 'Popular',      perLabel: '/ mes' },
  { id: 'trimestral', name: 'Trimestral', duration: '3 meses',  badge: null,           perLabel: '/ 3 meses' },
  { id: 'semestral',  name: 'Semestral',  duration: '6 meses',  badge: 'Mejor precio', perLabel: '/ 6 meses' },
  { id: 'anual',      name: 'Anual',      duration: '12 meses', badge: 'VIP',          perLabel: '/ año' },
];

const PLATFORM_DESCRIPTION = 'Todo CF Análisis, sin límites durante el periodo elegido.';
const PLATFORM_FEATURES = [
  'Análisis estadístico completo',
  'Apuesta del día inteligente',
  'Combinadas automáticas',
  'Marcadores en vivo',
  '15+ ligas internacionales',
  'Corners, tarjetas y BTTS',
];

export default function PlanesClient({
  email,
  mpPublicKey,
  autoCheckoutPlan,
  purchaseIntent,
}) {
  const [selectedPlan, setSelectedPlan] = useState(autoCheckoutPlan || null);
  const [prices, setPrices] = useState(null);
  const [pricesLoading, setPricesLoading] = useState(true);
  const [checkoutRoutingReady, setCheckoutRoutingReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [country, setCountry] = useState(null);
  const [mpModal, setMpModal] = useState(null);    // { plan, amountCop } → modal Mercado Pago (Colombia)
  const [paymentData, setPaymentData] = useState(null); // { clientSecret, plan, displayAmount } → modal Stripe (resto)
  const autoCheckoutStartedRef = useRef(false);
  const initialPlanIndex = Math.max(
    0,
    PLAN_ORDER.findIndex((plan) => plan.id === autoCheckoutPlan),
  );
  const [activePlanIndex, setActivePlanIndex] = useState(initialPlanIndex);
  const activePlanIndexRef = useRef(initialPlanIndex);
  const transitionLockRef = useRef(false);
  const unlockTimerRef = useRef(null);
  const wheelDeltaRef = useRef(0);
  const wheelResetRef = useRef(null);
  const touchStartRef = useRef(null);

  const fmtPrice = useCallback((planId) => {
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
  }, [prices, pricesLoading]);

  const fmtOriginal = (planId) => {
    const p = prices?.plans?.[planId];
    if (!p?.originalAmount) return null;
    const sym = p.nativeCurrency === 'EUR' ? '€' : p.nativeCurrency === 'USD' ? '$' : '';
    return `${sym}${p.originalAmount}`;
  };

  // Geo-routing del pago:
  //   Colombia → Mercado Pago (PSE/tarjeta) en MODAL embebido.
  //   Resto del mundo → Stripe (tarjeta internacional) en MODAL embebido.
  const goToCheckout = useCallback(async (planId) => {
    if (loading || !checkoutRoutingReady) return;
    setSelectedPlan(planId);
    setError('');

    const planPrice = prices?.plans?.[planId];
    if (!planPrice) {
      setError('No se pudo calcular el precio para tu ubicación. Recarga la página.');
      return;
    }

    // ── Colombia → Mercado Pago ──
    if (country === 'CO') {
      const copAmount = Math.round(planPrice.local || 0);
      if (!copAmount) { setError('No se pudo calcular el precio. Recarga la página.'); return; }
      setMpModal({ plan: planId, amountCop: copAmount });
      return;
    }

    // ── Resto del mundo → Stripe (PaymentIntent embebido) ──
    setLoading(true);
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: planId, email, currency: prices?.currency || 'USD' }),
      });
      const data = await res.json();
      if (data.clientSecret) {
        setPaymentData({
          clientSecret: data.clientSecret,
          plan: data.plan,
          displayAmount: fmtPrice(planId),
        });
      } else {
        setError(data.error || 'Error al procesar el pago');
      }
    } catch {
      setError('Error de conexion');
    } finally {
      setLoading(false);
    }
  }, [checkoutRoutingReady, country, email, fmtPrice, loading, prices]);

  useEffect(() => {
    let cancelled = false;

    const resolveCheckoutRouting = async () => {
      try {
        const countryResponse = await fetch('/api/detect-country');
        if (!countryResponse.ok) throw new Error('country_detection_failed');
        const countryData = await countryResponse.json();

        const browserCountry = navigator.language?.split('-')[1]?.toUpperCase();
        const detectedCountry = countryData.countryCode || browserCountry || null;
        const priceQuery = detectedCountry
          ? `country=${encodeURIComponent(detectedCountry)}`
          : `currency=${encodeURIComponent(countryData.currency || 'USD')}`;

        const pricesResponse = await fetch(`/api/currency?${priceQuery}`);
        if (!pricesResponse.ok) throw new Error('currency_detection_failed');
        const resolvedPrices = await pricesResponse.json();

        if (!cancelled) {
          setCountry(detectedCountry);
          setPrices(resolvedPrices);
        }
      } catch {
        if (!cancelled) {
          setError('No pudimos detectar el precio para tu ubicación. Recarga la página.');
        }
      } finally {
        if (!cancelled) {
          setPricesLoading(false);
          setCheckoutRoutingReady(true);
        }
      }
    };

    resolveCheckoutRouting();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (
      !autoCheckoutPlan
      || !checkoutRoutingReady
      || !prices
      || autoCheckoutStartedRef.current
    ) {
      return;
    }

    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('checkout');
    cleanUrl.searchParams.delete('intent');
    window.history.replaceState(
      window.history.state,
      '',
      `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`,
    );

    // React Strict Mode, Fast Refresh o un remount pueden repetir el efecto.
    // La intención única sobrevive al remount y se consume de forma síncrona.
    const dedupeId = purchaseIntent || autoCheckoutPlan;
    const dedupeKey = `cf:auto-checkout:${dedupeId}`;
    const lastAttemptAt = Number(sessionStorage.getItem(dedupeKey) || 0);
    const dedupeWindowMs = purchaseIntent ? 24 * 60 * 60 * 1000 : 30 * 1000;
    if (lastAttemptAt && Date.now() - lastAttemptAt < dedupeWindowMs) {
      autoCheckoutStartedRef.current = true;
      return;
    }

    sessionStorage.setItem(dedupeKey, String(Date.now()));
    autoCheckoutStartedRef.current = true;
    void goToCheckout(autoCheckoutPlan);
  }, [
    autoCheckoutPlan,
    checkoutRoutingReady,
    goToCheckout,
    prices,
    purchaseIntent,
  ]);

  const goToPlan = useCallback((target, force = false) => {
    if (transitionLockRef.current && !force) return;

    const nextIndex = Math.max(0, Math.min(PLAN_ORDER.length - 1, target));
    if (nextIndex === activePlanIndexRef.current) return;

    activePlanIndexRef.current = nextIndex;
    setActivePlanIndex(nextIndex);
    transitionLockRef.current = true;
    window.clearTimeout(unlockTimerRef.current);
    unlockTimerRef.current = window.setTimeout(() => {
      transitionLockRef.current = false;
    }, 110);
  }, []);

  const stepPlan = useCallback((direction) => {
    goToPlan(activePlanIndexRef.current + direction);
  }, [goToPlan]);

  // La selección de planes funciona como las escenas de la Home: el viewport
  // permanece fijo y cada gesto de scroll/swipe reemplaza el plan en el mismo
  // lugar. Cuando hay un checkout abierto devolvemos el scroll al modal.
  useEffect(() => {
    if (mpModal || paymentData) return undefined;

    const html = document.documentElement;
    const body = document.body;
    const previousHtmlOverflow = html.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousOverscroll = body.style.overscrollBehavior;

    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'none';

    const onWheel = (event) => {
      event.preventDefault();
      if (transitionLockRef.current) return;

      wheelDeltaRef.current += event.deltaY;
      window.clearTimeout(wheelResetRef.current);
      wheelResetRef.current = window.setTimeout(() => {
        wheelDeltaRef.current = 0;
      }, 160);

      if (Math.abs(wheelDeltaRef.current) >= 28) {
        const direction = wheelDeltaRef.current > 0 ? 1 : -1;
        wheelDeltaRef.current = 0;
        stepPlan(direction);
      }
    };

    const onKeyDown = (event) => {
      const tagName = event.target?.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(tagName)) return;

      if (['ArrowDown', 'PageDown', ' '].includes(event.key)) {
        event.preventDefault();
        stepPlan(1);
      } else if (['ArrowUp', 'PageUp'].includes(event.key)) {
        event.preventDefault();
        stepPlan(-1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        goToPlan(0, true);
      } else if (event.key === 'End') {
        event.preventDefault();
        goToPlan(PLAN_ORDER.length - 1, true);
      }
    };

    const onTouchStart = (event) => {
      touchStartRef.current = event.touches[0]?.clientY ?? null;
    };

    const onTouchMove = (event) => {
      event.preventDefault();
    };

    const onTouchEnd = (event) => {
      if (touchStartRef.current === null) return;
      const endY = event.changedTouches[0]?.clientY ?? touchStartRef.current;
      const distance = touchStartRef.current - endY;
      touchStartRef.current = null;
      if (Math.abs(distance) > 44) stepPlan(distance > 0 ? 1 : -1);
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.clearTimeout(unlockTimerRef.current);
      window.clearTimeout(wheelResetRef.current);
      html.style.overflow = previousHtmlOverflow;
      body.style.overflow = previousBodyOverflow;
      body.style.overscrollBehavior = previousOverscroll;
    };
  }, [goToPlan, mpModal, paymentData, stepPlan]);

  const activePlan = PLAN_ORDER[activePlanIndex];
  const activePlanOriginal = fmtOriginal(activePlan.id);
  const activePlanSelected = selectedPlan === activePlan.id;
  const activePlanPremium = activePlan.badge === 'VIP';

  return (
    <main className="planes-page">
      <div className="planes-bg" aria-hidden="true">
        <span className="planes-glow planes-glow-one" />
        <span className="planes-glow planes-glow-two" />
        <span className="planes-grid-bg" />
      </div>
      <motion.div
        className="planes-container"
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      >
        <motion.header
          className="planes-header"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.5 }}
        >
          <BrandLogoMedia
            className="planes-logo"
          />
          <p className="planes-eyebrow">
            <Sparkles size={14} aria-hidden="true" />
            Activa tu ventaja
          </p>
          <h1>Elige cómo quieres entrar</h1>
          <p className="planes-intro">
            Todos los planes incluyen la plataforma completa. Solo cambia el periodo.
          </p>
          <div className={`planes-routing-status ${checkoutRoutingReady ? 'is-ready' : ''}`}>
            <Globe2 size={15} aria-hidden="true" />
            <span>
              {checkoutRoutingReady
                ? `Precio en ${prices?.currency || 'USD'} · Pago con ${country === 'CO' ? 'Mercado Pago' : 'Stripe'}`
                : 'Detectando país y moneda…'}
            </span>
          </div>
        </motion.header>

        {error && <div className="modal-error planes-error" role="alert">{error}</div>}

        <section className="planes-stage" aria-label="Planes disponibles">
          <div className="planes-tabs" role="tablist" aria-label="Cambiar plan">
            {PLAN_ORDER.map((plan, index) => (
              <button
                key={plan.id}
                type="button"
                className={index === activePlanIndex ? 'is-active' : ''}
                onClick={() => goToPlan(index, true)}
                role="tab"
                aria-selected={index === activePlanIndex}
              >
                <span>{plan.name}</span>
                <small>{plan.duration}</small>
              </button>
            ))}
          </div>

          <div className="pricing-grid">
            <motion.article
              key={activePlan.id}
              className={`plan-card ${activePlanPremium ? 'premium' : ''} ${activePlanSelected ? 'selected' : ''}`}
              initial={{ opacity: 0, y: 22, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
              whileHover={{ y: -4 }}
              whileTap={{ scale: 0.985 }}
              onClick={() => goToCheckout(activePlan.id)}
              aria-disabled={!checkoutRoutingReady}
              role="button"
              tabIndex={checkoutRoutingReady ? 0 : -1}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  goToCheckout(activePlan.id);
                }
              }}
              style={{ cursor: loading || !checkoutRoutingReady ? 'wait' : 'pointer' }}
            >
              {activePlan.badge && (
                <div className={`plan-badge ${activePlanPremium ? 'premium' : ''}`}>{activePlan.badge}</div>
              )}
              <div className="plan-card-head">
                <div>
                  <span className="plan-duration">{activePlan.duration}</span>
                  <h2 className="plan-name">Plan {activePlan.name}</h2>
                </div>
                {activePlanSelected && (
                  <span className="plan-selected-mark" aria-label="Plan seleccionado">
                    <Check size={16} strokeWidth={2.6} aria-hidden="true" />
                  </span>
                )}
              </div>
              <p className="plan-desc">{PLATFORM_DESCRIPTION}</p>
              <div className="plan-price">
                {activePlanOriginal && (
                  <span className="plan-amount-original">{activePlanOriginal}</span>
                )}
                <span className="plan-amount">{fmtPrice(activePlan.id)}</span>
                <span className="plan-period">{activePlan.perLabel}</span>
              </div>
              <div className="plan-after">Cobro automático · Cancela cuando quieras</div>
              <ul className="plan-features">
                {PLATFORM_FEATURES.map((feature) => (
                  <li key={feature}>
                    <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                    {feature}
                  </li>
                ))}
              </ul>
              <div className="plan-card-action">
                {!checkoutRoutingReady && activePlanSelected
                  ? <span className="modal-loading">Detectando país y moneda…</span>
                  : checkoutRoutingReady && loading && activePlanSelected
                    ? <span className="modal-loading">Preparando pago…</span>
                    : (
                      <>
                        <span>Elegir Plan {activePlan.name}</span>
                        <ChevronRight size={17} aria-hidden="true" />
                      </>
                    )}
              </div>
            </motion.article>
          </div>

          <div className="planes-navigation">
            <button
              type="button"
              onClick={() => stepPlan(-1)}
              disabled={activePlanIndex === 0}
              aria-label="Plan anterior"
            >
              <ChevronUp size={18} aria-hidden="true" />
            </button>
            <div className="planes-progress" aria-label={`Plan ${activePlanIndex + 1} de ${PLAN_ORDER.length}`}>
              {PLAN_ORDER.map((plan, index) => (
                <button
                  key={plan.id}
                  type="button"
                  className={index === activePlanIndex ? 'is-active' : ''}
                  onClick={() => goToPlan(index, true)}
                  aria-label={`Ver Plan ${plan.name}`}
                  aria-current={index === activePlanIndex ? 'step' : undefined}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => stepPlan(1)}
              disabled={activePlanIndex === PLAN_ORDER.length - 1}
              aria-label="Plan siguiente"
            >
              <ChevronDown size={18} aria-hidden="true" />
            </button>
          </div>
          <p className="planes-scroll-cue" aria-hidden="true">
            Desliza para comparar
            <ChevronDown size={14} />
          </p>
        </section>

        <div className="planes-footer">
          <div className="planes-trust">
            <span><ShieldCheck size={15} aria-hidden="true" /> Pago protegido</span>
            <span><LockKeyhole size={15} aria-hidden="true" /> Datos cifrados</span>
          </div>
          <button
            className="planes-signout"
            onClick={() => fetch('/api/auth/logout', { method: 'POST' }).finally(() => window.location.href = '/')}
          >
            <LogOut size={15} aria-hidden="true" />
            Cerrar sesión
          </button>
        </div>
      </motion.div>

      {/* Colombia → Mercado Pago */}
      {mpModal && (
        <MercadoPagoModal
          plan={mpModal.plan}
          planLabel={`Plan ${mpModal.plan.charAt(0).toUpperCase()}${mpModal.plan.slice(1)}`}
          amountCop={mpModal.amountCop}
          email={email}
          publicKey={mpPublicKey}
          onClose={() => { setMpModal(null); setSelectedPlan(null); }}
        />
      )}

      {/* Resto del mundo → Stripe */}
      {paymentData && (
        <PaymentModal
          clientSecret={paymentData.clientSecret}
          plan={paymentData.plan}
          displayAmount={paymentData.displayAmount}
          onClose={() => { setPaymentData(null); setSelectedPlan(null); }}
        />
      )}
    </main>
  );
}
