'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  BadgeDollarSign,
  BarChart3,
  Check,
  Globe2,
  Layers3,
  PanelsTopLeft,
  Radio,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
} from 'lucide-react';
import AndroidIcon from '../components/AndroidIcon';
import { ANDROID_APK_URL } from '../lib/app-download';
import { useAuth } from '../components/providers';
import LandingBrandVideo from '../components/LandingBrandVideo';
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

// Red lenta con la secuencia en el HTML: sus imágenes compiten con la carga de
// la portada y la animación arranca antes de que lleguen, así que lo primero que
// se ve no es el balón de fútbol sino el que toque en ese momento. Los objetos
// se montan cuando la página ya ha cargado y sus imágenes están descodificadas;
// al montarse, la animación empieza desde el primer fotograma.
const SEQUENCE_FALLBACK_MS = 5000;

function SportsSequence() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let fallback;

    const preload = () => {
      window.clearTimeout(fallback);
      Promise.all(SPORTS_SEQUENCE.map(({ src }) => {
        const image = new Image();
        image.src = src;
        return image.decode().catch(() => undefined);
      })).then(() => {
        if (!cancelled) setReady(true);
      });
    };

    if (document.readyState === 'complete') {
      preload();
    } else {
      window.addEventListener('load', preload, { once: true });
      // Si `load` no llegara a dispararse, la fila no puede quedarse vacía.
      fallback = window.setTimeout(preload, SEQUENCE_FALLBACK_MS);
    }

    return () => {
      cancelled = true;
      window.clearTimeout(fallback);
      window.removeEventListener('load', preload);
    };
  }, []);

  return (
    <div
      className="apple-sports-sequence"
      role="img"
      aria-label="Balones de fútbol, béisbol y baloncesto junto a un casco de fútbol americano"
    >
      <div className="apple-sports-stage" aria-hidden="true">
        {ready && SPORTS_SEQUENCE.map((sport) => (
          <img
            key={sport.key}
            className={`apple-sport-object is-${sport.key}`}
            src={sport.src}
            alt=""
            decoding="async"
          />
        ))}
        {ready && <span className="apple-sports-shine" />}
      </div>
    </div>
  );
}

export default function LandingPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [activePlanIndex, setActivePlanIndex] = useState(1);
  const [prices, setPrices] = useState(null);
  const [pricesLoading, setPricesLoading] = useState(true);

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

  const beginPlanPurchase = useCallback((planId) => {
    const purchaseIntent = createPurchaseIntent();
    router.push(purchaseRoute('/sign-up', 'plan', planId, purchaseIntent));
  }, [router]);

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

  const activePlan = PLANS[activePlanIndex];
  const originalPrice = fmtOriginal(activePlan.id);
  return (
    <main className="landing landing-apple landing-scroll">
      <div className="apple-ambient" aria-hidden="true">
        <span className="apple-glow apple-glow-one" />
        <span className="apple-glow apple-glow-two" />
        <span className="apple-grid" />
      </div>

      <LandingBrandVideo className="apple-brand-video is-hero" />

      <div className="apple-stage">
        <section className="apple-scene apple-hero-scene is-active">
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
              <a className="btn-hero-sec" href={ANDROID_APK_URL} download rel="noopener">
                <AndroidIcon size={18} />
                Instalar App
              </a>
              <button className="btn-hero-sec" onClick={() => router.push('/rendimiento')}>
                <ShieldCheck size={18} aria-hidden="true" />
                Ver rendimiento
              </button>
            </div>
            <div className="apple-hero-stats" aria-label="Resumen de cobertura">
              <div><strong>15+</strong><span>Ligas</span></div>
              <div><strong>500+</strong><span>Partidos al día</span></div>
              <div><strong>12+</strong><span>Mercados</span></div>
            </div>
            <SportsSequence />
          </div>
        </section>

        <section id="funciones" className="apple-scene is-active">
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

        <section className="apple-scene is-active">
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

        <section id="precios" className="apple-scene apple-pricing-scene is-active">
          <div className="apple-scene-inner">
            <header className="apple-scene-header apple-pricing-header">
              <p className="apple-eyebrow">Acceso completo</p>
              <h2>Un plan para cada ritmo</h2>
              <p>Compara los periodos y cancela cuando quieras.</p>
            </header>

            <div className="apple-plan-tabs" role="tablist" aria-label="Planes disponibles">
              {PLANS.map((plan, index) => (
                <button
                  key={plan.id}
                  className={index === activePlanIndex ? 'is-active' : ''}
                  onClick={() => setActivePlanIndex(index)}
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

        <section className="apple-scene apple-final-scene is-active">
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
                <button onClick={() => document.getElementById('funciones')?.scrollIntoView({ behavior: 'smooth' })}>Funciones</button>
                <button onClick={() => document.getElementById('precios')?.scrollIntoView({ behavior: 'smooth' })}>Precios</button>
                <button onClick={() => router.push('/rendimiento')}>Rendimiento</button>
                <button onClick={() => router.push('/terminos')}>Términos</button>
                <button onClick={() => router.push('/privacidad')}>Privacidad</button>
                <button onClick={() => router.push('/cookies')}>Cookies</button>
              </div>
            </footer>
          </div>
        </section>
      </div>

    </main>
  );
}
