'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  BadgeDollarSign,
  BarChart3,
  Check,
  ChevronDown,
  ChevronUp,
  Globe2,
  Layers3,
  PanelsTopLeft,
  Radio,
  Sparkles,
  Target,
  Users,
} from 'lucide-react';
import { useAuth } from '../components/providers';
import BrandLogoMedia from '../components/BrandLogoMedia';
import { createPurchaseIntent, purchaseRoute } from '../lib/purchase-flow';

const FEATURES = [
  { icon: BarChart3, title: 'Análisis estadístico', desc: 'H2H, forma, goles y rendimiento local o visitante con datos reales.' },
  { icon: Target, title: 'Apuesta del día', desc: 'El algoritmo selecciona las oportunidades con mejor respaldo estadístico.' },
  { icon: Layers3, title: 'Combinadas automáticas', desc: 'Combinaciones inteligentes con probabilidades y cuotas calculadas.' },
  { icon: Radio, title: 'Marcadores en vivo', desc: 'Actualización continua de todos los partidos que están en juego.' },
  { icon: Globe2, title: 'Más de 15 ligas', desc: 'Premier, La Liga, Serie A, Bundesliga, Ligue 1, Liga MX y BetPlay.' },
  { icon: PanelsTopLeft, title: 'Corners y tarjetas', desc: 'Mercados especiales basados en datos históricos y contexto real.' },
  { icon: Users, title: 'XI titulares', desc: 'Alineaciones confirmadas y bajas antes de que comience el partido.' },
  { icon: BadgeDollarSign, title: 'Cuotas en tiempo real', desc: 'Cuotas integradas para comparar cada mercado desde un solo lugar.' },
];

const PLANS = [
  { id: 'semanal', label: 'Semanal', short: '7 días', badge: null, perLabel: '/ semana' },
  { id: 'mensual', label: 'Mensual', short: '1 mes', badge: 'Popular', perLabel: '/ mes' },
  { id: 'trimestral', label: 'Trimestral', short: '3 meses', badge: null, perLabel: '/ 3 meses' },
  { id: 'semestral', label: 'Semestral', short: '6 meses', badge: 'Mejor precio', perLabel: '/ 6 meses' },
  { id: 'anual', label: 'Anual', short: '1 año', badge: 'VIP', perLabel: '/ año' },
];

const PLAN_BENEFITS = [
  'Análisis estadístico completo',
  'Apuesta del día inteligente',
  'Combinadas automáticas',
  'Marcadores en vivo',
  'Más de 15 ligas internacionales',
  'Corners, tarjetas y BTTS',
];

const FIRST_PLAN_SCENE = 3;
const LAST_PLAN_SCENE = FIRST_PLAN_SCENE + PLANS.length - 1;
const FINAL_SCENE = LAST_PLAN_SCENE + 1;
const SCENE_LABELS = [
  'Inicio',
  'Funciones',
  'Cómo funciona',
  ...PLANS.map((plan) => `Plan ${plan.label}`),
  'Empieza ahora',
];

const pressCard = (event) => {
  event.currentTarget.classList.add('is-pressed');
};

const releaseCard = (event) => {
  event.currentTarget.classList.remove('is-pressed');
};

const SPORTS_SEQUENCE = [
  { key: 'football', src: '/sports-sequence/football.webp' },
  { key: 'baseball', src: '/sports-sequence/baseball.webp' },
  { key: 'basketball', src: '/sports-sequence/basketball.webp' },
  { key: 'helmet', src: '/sports-sequence/helmet.webp' },
];

function SportsSequence() {
  return (
    <div
      className="apple-sports-sequence"
      role="img"
      aria-label="Balones de fútbol, béisbol y baloncesto junto a un casco de fútbol americano"
    >
      <div className="apple-sports-stage" aria-hidden="true">
        {SPORTS_SEQUENCE.map((sport) => (
          <img
            key={sport.key}
            className={`apple-sport-object is-${sport.key}`}
            src={sport.src}
            alt=""
            loading="eager"
            decoding="async"
          />
        ))}
        <span className="apple-sports-shine" />
      </div>
    </div>
  );
}

export default function LandingPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [activeScene, setActiveScene] = useState(0);
  const [prices, setPrices] = useState(null);
  const [pricesLoading, setPricesLoading] = useState(true);

  const activeSceneRef = useRef(0);
  const transitionLockRef = useRef(false);
  const unlockTimerRef = useRef(null);
  const wheelDeltaRef = useRef(0);
  const wheelResetRef = useRef(null);
  const touchStartRef = useRef(null);

  useEffect(() => {
    if (!authLoading && user) router.push('/dashboard');
  }, [user, authLoading, router]);

  useEffect(() => {
    fetch('/api/detect-country')
      .then((response) => response.json())
      .then((data) => {
        const browserCountry = navigator.language?.split('-')[1]?.toUpperCase();
        const countryCode = data.countryCode || browserCountry;
        const query = countryCode
          ? `country=${encodeURIComponent(countryCode)}`
          : `currency=${encodeURIComponent(data.currency || 'USD')}`;

        return fetch(`/api/currency?${query}`);
      })
      .then((response) => {
        if (!response?.ok) throw new Error('No se pudieron cargar los precios');
        return response.json();
      })
      .then(setPrices)
      .catch(() => {})
      .finally(() => setPricesLoading(false));
  }, []);

  const releaseNavigation = useCallback(() => {
    window.clearTimeout(unlockTimerRef.current);
    unlockTimerRef.current = window.setTimeout(() => {
      transitionLockRef.current = false;
    }, 110);
  }, []);

  const goToScene = useCallback((target, force = false) => {
    if (transitionLockRef.current && !force) return;

    const nextScene = Math.max(0, Math.min(FINAL_SCENE, target));
    if (nextScene === activeSceneRef.current) return;

    activeSceneRef.current = nextScene;
    setActiveScene(nextScene);
    transitionLockRef.current = true;
    releaseNavigation();
  }, [releaseNavigation]);

  const stepScene = useCallback((direction) => {
    goToScene(activeSceneRef.current + direction);
  }, [goToScene]);

  const beginPlanPurchase = useCallback((planId) => {
    const purchaseIntent = createPurchaseIntent();
    router.push(purchaseRoute('/sign-up', 'plan', planId, purchaseIntent));
  }, [router]);

  useEffect(() => {
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
        stepScene(direction);
      }
    };

    const onKeyDown = (event) => {
      const tagName = event.target?.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(tagName)) return;

      if (['ArrowDown', 'PageDown', ' '].includes(event.key)) {
        event.preventDefault();
        stepScene(1);
      } else if (['ArrowUp', 'PageUp'].includes(event.key)) {
        event.preventDefault();
        stepScene(-1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        goToScene(0, true);
      } else if (event.key === 'End') {
        event.preventDefault();
        goToScene(FINAL_SCENE, true);
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
      if (Math.abs(distance) > 44) stepScene(distance > 0 ? 1 : -1);
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
  }, [goToScene, stepScene]);

  const fmtPrice = (planId) => {
    if (pricesLoading) return 'Cargando…';
    const plan = prices?.plans?.[planId];
    if (!plan) return '—';

    if (plan.fixedCurrency) {
      const symbol = plan.nativeCurrency === 'EUR' ? '€' : plan.nativeCurrency === 'USD' ? '$' : '';
      return `${symbol}${plan.nativeAmount} ${plan.nativeCurrency}`;
    }

    const local = plan.local;
    const currency = plan.currency;
    const fallback = plan.nativeAmount ?? plan.usd;
    if (!local || !currency || currency === 'USD') return `$${fallback} USD`;
    return `${Math.round(local).toLocaleString()} ${currency}`;
  };

  const fmtOriginal = (planId) => {
    const plan = prices?.plans?.[planId];
    if (!plan?.originalAmount) return null;
    const symbol = plan.nativeCurrency === 'EUR' ? '€' : plan.nativeCurrency === 'USD' ? '$' : '';
    return `${symbol}${plan.originalAmount}`;
  };

  const sceneState = (index) => (
    activeScene === index ? 'is-active' : activeScene > index ? 'is-before' : 'is-after'
  );

  const pricingState = (
    activeScene < FIRST_PLAN_SCENE
      ? 'is-after'
      : activeScene > LAST_PLAN_SCENE
        ? 'is-before'
        : 'is-active'
  );

  const activePlanIndex = Math.max(0, Math.min(PLANS.length - 1, activeScene - FIRST_PLAN_SCENE));
  const activePlan = PLANS[activePlanIndex];
  const originalPrice = fmtOriginal(activePlan.id);
  return (
    <main className="landing landing-apple">
      <div className="apple-ambient" aria-hidden="true">
        <span className="apple-glow apple-glow-one" />
        <span className="apple-glow apple-glow-two" />
        <span className="apple-grid" />
      </div>

      <BrandLogoMedia
        className={`apple-brand-video ${activeScene === 0 ? 'is-hero' : activeScene === FINAL_SCENE ? 'is-finale' : 'is-away'}`}
      />

      <div className="apple-stage">
        <section className={`apple-scene apple-hero-scene ${sceneState(0)}`} aria-hidden={activeScene !== 0}>
          <div className="apple-hero-copy">
            <p className="apple-kicker"><span /> Datos deportivos en tiempo real</p>
            <h1 className="apple-hero-title">
              Tu ventaja en
              <span>cada apuesta</span>
            </h1>
            <p className="apple-hero-sub">
              Análisis de fútbol, combinadas inteligentes y probabilidades calculadas
              con datos reales de más de 15 ligas.
            </p>
            <div className="apple-hero-actions">
              <button className="btn-hero" onClick={() => router.push('/sign-up')}>
                Empezar ahora <ArrowRight size={18} aria-hidden="true" />
              </button>
              <button className="btn-hero-sec" onClick={() => goToScene(1, true)}>
                Descubrir funciones
              </button>
            </div>
            <div className="apple-hero-stats" aria-label="Resumen de cobertura">
              <div><strong>15+</strong><span>Ligas</span></div>
              <div><strong>500+</strong><span>Partidos al día</span></div>
              <div><strong>12+</strong><span>Mercados</span></div>
            </div>
            {activeScene === 0 && <SportsSequence />}
          </div>
        </section>

        <section className={`apple-scene ${sceneState(1)}`} aria-hidden={activeScene !== 1}>
          <div className="apple-scene-inner apple-features-scene">
            <header className="apple-scene-header">
              <p className="apple-eyebrow">Todo en una plataforma</p>
              <h2>Datos que se convierten en decisiones</h2>
              <p>La información importante aparece antes de que tengas que buscarla.</p>
            </header>
            <div className="apple-features-grid">
              {FEATURES.map(({ icon: Icon, title, desc }, index) => (
                <article
                  className="apple-feature-card"
                  key={title}
                  style={{ '--item': index }}
                  onPointerDown={pressCard}
                  onPointerUp={releaseCard}
                  onPointerCancel={releaseCard}
                  onPointerLeave={releaseCard}
                >
                  <span className="apple-feature-icon"><Icon size={21} strokeWidth={1.8} aria-hidden="true" /></span>
                  <div>
                    <h3>{title}</h3>
                    <p>{desc}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={`apple-scene ${sceneState(2)}`} aria-hidden={activeScene !== 2}>
          <div className="apple-scene-inner apple-process-scene">
            <header className="apple-scene-header">
              <p className="apple-eyebrow">Simple por fuera. Potente por dentro.</p>
              <h2>De cero a tu primer análisis</h2>
              <p>Tres pasos y toda la plataforma empieza a trabajar para ti.</p>
            </header>
            <div className="apple-process">
              {[
                ['01', 'Regístrate', 'Crea tu cuenta en menos de 30 segundos.'],
                ['02', 'Elige tu plan', 'Selecciona el periodo que mejor se adapte a ti.'],
                ['03', 'Analiza con ventaja', 'Accede a estadísticas y combinadas inteligentes.'],
              ].map(([number, title, description], index) => (
                <article
                  className="apple-process-step"
                  key={number}
                  onPointerDown={pressCard}
                  onPointerUp={releaseCard}
                  onPointerCancel={releaseCard}
                  onPointerLeave={releaseCard}
                >
                  <span className="apple-process-number">{number}</span>
                  <div>
                    <h3>{title}</h3>
                    <p>{description}</p>
                  </div>
                  {index < 2 && <span className="apple-process-line" aria-hidden="true" />}
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={`apple-scene apple-pricing-scene ${pricingState}`} aria-hidden={pricingState !== 'is-active'}>
          <div className="apple-scene-inner">
            <header className="apple-scene-header apple-pricing-header">
              <p className="apple-eyebrow">Acceso completo</p>
              <h2>Un plan para cada ritmo</h2>
              <p>Desliza para comparar. Cancela cuando quieras.</p>
            </header>

            <div className="apple-plan-tabs" role="tablist" aria-label="Planes disponibles">
              {PLANS.map((plan, index) => (
                <button
                  key={plan.id}
                  className={index === activePlanIndex ? 'is-active' : ''}
                  onClick={() => goToScene(FIRST_PLAN_SCENE + index, true)}
                  role="tab"
                  aria-selected={index === activePlanIndex}
                >
                  <span className="apple-plan-label">{plan.label}</span>
                  <span className="apple-plan-short">{plan.short}</span>
                </button>
              ))}
            </div>

            <article
              className={`apple-plan-card ${activePlan.id === 'anual' ? 'is-vip' : ''}`}
              key={activePlan.id}
              onPointerDown={pressCard}
              onPointerUp={releaseCard}
              onPointerCancel={releaseCard}
              onPointerLeave={releaseCard}
            >
              <div className="apple-plan-topline">
                <div>
                  <p className="apple-plan-overline">Plan {activePlan.label}</p>
                  <h3>Acceso total a CF Análisis</h3>
                </div>
                {activePlan.badge && <span className="apple-plan-badge">{activePlan.badge}</span>}
              </div>

              <div className="apple-plan-price">
                {originalPrice && <span className="apple-plan-original">{originalPrice}</span>}
                <strong>{fmtPrice(activePlan.id)}</strong>
                <span>{activePlan.perLabel}</span>
              </div>

              <ul className="apple-plan-benefits">
                {PLAN_BENEFITS.map((benefit) => (
                  <li key={benefit}><Check size={16} strokeWidth={2.4} aria-hidden="true" /> {benefit}</li>
                ))}
              </ul>

              <button
                className="apple-plan-cta"
                onClick={() => beginPlanPurchase(activePlan.id)}
              >
                Elegir plan {activePlan.label.toLowerCase()} <ArrowRight size={17} aria-hidden="true" />
              </button>
            </article>
          </div>
        </section>

        <section className={`apple-scene apple-final-scene ${sceneState(FINAL_SCENE)}`} aria-hidden={activeScene !== FINAL_SCENE}>
          <div className="apple-final-content">
            <p className="apple-kicker"><Sparkles size={16} aria-hidden="true" /> Tu ventaja empieza aquí</p>
            <h2>Menos intuición.<br /><span>Más información.</span></h2>
            <p>Entra a CF Análisis y convierte cada dato en una decisión mejor respaldada.</p>
            <button className="btn-hero apple-final-cta" onClick={() => router.push('/sign-up')}>
              Crear mi cuenta <ArrowRight size={18} aria-hidden="true" />
            </button>
            <footer className="apple-footer">
              <p>CFanalisis.com — Tu ventaja en cada apuesta</p>
              <div>
                <button onClick={() => router.push('/sign-in')}>Iniciar sesión</button>
                <button onClick={() => goToScene(1, true)}>Funciones</button>
                <button onClick={() => goToScene(FIRST_PLAN_SCENE, true)}>Precios</button>
              </div>
            </footer>
          </div>
        </section>
      </div>

      <nav className="apple-progress" aria-label="Secciones de la página">
        {SCENE_LABELS.map((label, index) => (
          <button
            key={label}
            className={index === activeScene ? 'is-active' : ''}
            onClick={() => goToScene(index, true)}
            aria-label={`Ir a ${label}`}
            aria-current={index === activeScene ? 'step' : undefined}
          >
            <span />
          </button>
        ))}
      </nav>

      <div className="apple-scene-count" aria-hidden="true">
        <strong>{String(activeScene + 1).padStart(2, '0')}</strong>
        <span>/</span>
        <span>{String(SCENE_LABELS.length).padStart(2, '0')}</span>
      </div>

      <div className="apple-scene-controls">
        <button onClick={() => stepScene(-1)} disabled={activeScene === 0} aria-label="Escena anterior">
          <ChevronUp size={19} aria-hidden="true" />
        </button>
        <button onClick={() => stepScene(1)} disabled={activeScene === FINAL_SCENE} aria-label="Escena siguiente">
          <ChevronDown size={19} aria-hidden="true" />
        </button>
      </div>

      <p className={`apple-scroll-cue ${activeScene === FINAL_SCENE ? 'is-hidden' : ''}`} aria-hidden="true">
        <span className="apple-cue-desktop">Desliza para continuar</span>
        <span className="apple-cue-mobile">Desliza hacia arriba</span>
        <ChevronDown size={15} />
      </p>

      <p className="apple-sr-only" aria-live="polite">
        Sección {activeScene + 1} de {SCENE_LABELS.length}: {SCENE_LABELS[activeScene]}
      </p>
    </main>
  );
}
