'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../components/providers';

export default function LandingPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  // If already logged in, redirect to dashboard
  useEffect(() => {
    if (!authLoading && user) router.push('/dashboard');
  }, [user, authLoading, router]);

  // Scroll-driven animations with IntersectionObserver
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
          }
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -50px 0px' }
    );

    const selectors = '.feature-card, .step, .step-arrow, .plan-card, .landing-section-title, .section-sub, .reveal, .reveal-left, .reveal-right, .reveal-scale';
    document.querySelectorAll(selectors).forEach(el => observer.observe(el));

    return () => observer.disconnect();
  }, []);

  const [prices, setPrices] = useState(null);
  const [pricesLoading, setPricesLoading] = useState(true);

  // Detect user country for currency
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

  const fmtPrice = (planId) => {
    if (pricesLoading) return '...';
    const p = prices?.plans?.[planId];
    // Plan con fixedCurrency (ej. anual EUR): mostrar siempre su moneda nativa
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

  const features = [
    { icon: '&#128200;', title: 'Analisis Estadistico', desc: 'H2H, forma reciente, goles, rendimiento local y visitante con datos reales' },
    { icon: '&#127919;', title: 'Apuesta del Dia', desc: 'Algoritmo inteligente selecciona las mejores apuestas del dia automaticamente' },
    { icon: '&#127920;', title: 'Combinadas Auto', desc: 'Sistema genera combinadas con probabilidades reales y cuotas calculadas' },
    { icon: '&#9889;', title: 'Marcadores en Vivo', desc: 'Actualizacion cada minuto de todos los partidos en juego' },
    { icon: '&#127758;', title: '15+ Ligas', desc: 'Premier, La Liga, Serie A, Bundesliga, Ligue 1, Liga MX, BetPlay y mas' },
    { icon: '&#127183;', title: 'Corners y Tarjetas', desc: 'Probabilidades de corners, tarjetas y BTTS basadas en datos historicos' },
    { icon: '&#128101;', title: 'XI Titulares', desc: 'Alineaciones confirmadas y bajas 45 min antes del partido' },
    { icon: '&#128202;', title: 'Cuotas en Tiempo Real', desc: 'Cuotas de casas de apuestas integradas para cada mercado' },
  ];

  return (
    <div className="landing">
      {/* HERO */}
      <section className="hero">
        <div className="hero-bg" />
        <div className="hero-content">
          <img src="/vflogo.png" alt="CFanalisis" className="hero-logo" />
          <h1 className="hero-title">
            Tu ventaja en<br />
            <span className="hero-accent">cada apuesta</span>
          </h1>
          <p className="hero-sub">
            Plataforma avanzada de analisis de futbol. Estadisticas reales, combinadas inteligentes
            y probabilidades calculadas con datos de mas de 15 ligas internacionales.
          </p>
          <div className="hero-btns">
            <button className="btn-hero" onClick={() => router.push('/sign-up')}>Empezar Ahora</button>
            <a href="#features" className="btn-hero-sec">Ver funciones</a>
          </div>
          <div className="hero-stats">
            <div className="hero-stat"><span className="hero-stat-n">15+</span><span className="hero-stat-l">Ligas</span></div>
            <div className="hero-stat"><span className="hero-stat-n">500+</span><span className="hero-stat-l">Partidos/dia</span></div>
            <div className="hero-stat"><span className="hero-stat-n">12+</span><span className="hero-stat-l">Mercados</span></div>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section className="features" id="features">
        <h2 className="landing-section-title">Todo lo que necesitas para apostar con ventaja</h2>
        <p className="section-sub">Herramientas profesionales de analisis en una sola plataforma</p>
        <div className="features-grid">
          {features.map((f, i) => (
            <div key={i} className="feature-card" style={{ '--i': i }}>
              <div className="feature-icon" dangerouslySetInnerHTML={{ __html: f.icon }} />
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="how-it-works">
        <h2 className="landing-section-title">Como funciona</h2>
        <div className="steps">
          <div className="step">
            <div className="step-n">1</div>
            <h3>Registrate</h3>
            <p>Crea tu cuenta en 30 segundos con tu email</p>
          </div>
          <div className="step-arrow">&#8594;</div>
          <div className="step">
            <div className="step-n">2</div>
            <h3>Elige tu plan</h3>
            <p>Semanal, mensual, trimestral, semestral o anual</p>
          </div>
          <div className="step-arrow">&#8594;</div>
          <div className="step">
            <div className="step-n">3</div>
            <h3>Empieza a ganar</h3>
            <p>Accede a analisis y combinadas inteligentes</p>
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section className="pricing" id="pricing">
        <h2 className="landing-section-title">Planes de acceso</h2>
        <p className="section-sub">Elige el periodo que mejor se ajuste a ti. Cobro automatico, cancela cuando quieras.</p>
        <div className="pricing-grid">
          {[
            { id: 'semanal',    badge: null,             perLabel: '/ semana' },
            { id: 'mensual',    badge: 'Popular',        perLabel: '/ mes' },
            { id: 'trimestral', badge: null,             perLabel: '/ 3 meses' },
            { id: 'semestral',  badge: 'Mejor precio',   perLabel: '/ 6 meses' },
            { id: 'anual',      badge: 'VIP',            perLabel: '/ año' },
          ].map((plan) => {
            const isPremium = plan.badge === 'VIP';
            const original = fmtOriginal(plan.id);
            return (
              <div key={plan.id} className={`plan-card ${isPremium ? 'premium' : ''}`}>
                {plan.badge && <div className={`plan-badge ${isPremium ? 'premium' : ''}`}>{plan.badge}</div>}
                <h3 className="plan-name">{`Plan ${plan.id.charAt(0).toUpperCase() + plan.id.slice(1)}`}</h3>
                <p className="plan-desc">Acceso total a estadisticas, analisis y herramientas de apuesta</p>
                <div className="plan-price">
                  {original && (
                    <span className="plan-amount-original" style={{ textDecoration: 'line-through', opacity: 0.55, marginRight: 8, fontSize: '0.7em' }}>{original}</span>
                  )}
                  <span className="plan-amount">{fmtPrice(plan.id)}</span>
                  <span className="plan-period">{plan.perLabel}</span>
                </div>
                <div className="plan-after">Cobro automatico cada periodo</div>
                <ul className="plan-features">
                  <li>Analisis estadistico completo</li>
                  <li>Apuesta del Dia inteligente</li>
                  <li>Combinadas automaticas</li>
                  <li>Marcadores en vivo</li>
                  <li>15+ ligas internacionales</li>
                  <li>Corners, tarjetas, BTTS</li>
                </ul>
                <button className={`btn-plan ${isPremium ? 'premium' : ''}`} onClick={() => router.push('/sign-up')}>Empezar Ahora</button>
              </div>
            );
          })}
        </div>
      </section>

      {/* FOOTER */}
      <footer className="landing-footer">
        <img src="/vflogo.png" alt="CFanalisis" className="footer-logo" />
        <p>CFanalisis.com &mdash; Tu ventaja en cada apuesta</p>
        <div className="footer-links">
          <button className="footer-link-btn" onClick={() => router.push('/sign-in')}>Iniciar sesion</button>
          <a href="#features">Funciones</a>
          <a href="#pricing">Precios</a>
        </div>
      </footer>
    </div>
  );
}
