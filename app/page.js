'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUser, SignUpButton, SignInButton } from '@clerk/nextjs';

export default function LandingPage() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useUser();

  // If already logged in, redirect to dashboard
  useEffect(() => {
    if (isLoaded && isSignedIn) router.push('/dashboard');
  }, [isSignedIn, isLoaded, router]);

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

    const selectors = '.feature-card, .step, .step-arrow, .plan-card, .section-title, .section-sub, .reveal, .reveal-left, .reveal-right, .reveal-scale';
    document.querySelectorAll(selectors).forEach(el => observer.observe(el));

    return () => observer.disconnect();
  }, []);

  const [prices, setPrices] = useState(null);

  // Detect user country for currency
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

  const fmtPrice = (usd, local, currency) => {
    if (!local || currency === 'USD') return `$${usd} USD`;
    return `$${usd} USD (~${currency} ${local.toLocaleString()})`;
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
            <SignUpButton mode="modal" forceRedirectUrl="/planes">
              <button className="btn-hero">Empezar Ahora</button>
            </SignUpButton>
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
        <h2 className="section-title">Todo lo que necesitas para apostar con ventaja</h2>
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
        <h2 className="section-title">Como funciona</h2>
        <div className="steps">
          <div className="step">
            <div className="step-n">1</div>
            <h3>Registrate</h3>
            <p>Crea tu cuenta en 30 segundos con tu email o Google</p>
          </div>
          <div className="step-arrow">&#8594;</div>
          <div className="step">
            <div className="step-n">2</div>
            <h3>Elige tu plan</h3>
            <p>Plataforma o Asesoria segun tus necesidades</p>
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
        <h2 className="section-title">Planes de acceso</h2>
        <p className="section-sub">Invierte en tu ventaja. Primer mes con 50% de descuento.</p>
        <div className="pricing-grid">
          {/* Plan 1: Plataforma */}
          <div className="plan-card">
            <div className="plan-badge">Popular</div>
            <h3 className="plan-name">Plan Plataforma</h3>
            <p className="plan-desc">Acceso total a estadisticas, analisis y herramientas de apuesta</p>
            <div className="plan-price">
              <span className="plan-amount">{fmtPrice(15, prices?.plans?.plataforma?.firstMonth?.local, prices?.currency)}</span>
              <span className="plan-period">primer mes (50% dto.)</span>
            </div>
            <div className="plan-after">Luego {fmtPrice(30, prices?.plans?.plataforma?.regular?.local, prices?.currency)}/mes</div>
            <ul className="plan-features">
              <li>Analisis estadistico completo</li>
              <li>Apuesta del Dia inteligente</li>
              <li>Combinadas automaticas</li>
              <li>Marcadores en vivo</li>
              <li>15+ ligas internacionales</li>
              <li>Corners, tarjetas, BTTS</li>
            </ul>
            <SignUpButton mode="modal" forceRedirectUrl="/planes">
              <button className="btn-plan">Empezar Ahora</button>
            </SignUpButton>
          </div>

          {/* Plan 2: Asesoria */}
          <div className="plan-card premium">
            <div className="plan-badge premium">VIP</div>
            <h3 className="plan-name">Plan Asesoria</h3>
            <p className="plan-desc">Formacion en apuestas, estrategias, bankroll + acceso total a plataforma</p>
            <div className="plan-price">
              <span className="plan-amount">{fmtPrice(100, prices?.plans?.asesoria?.initial?.local, prices?.currency)}</span>
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
            <SignUpButton mode="modal" forceRedirectUrl="/planes">
              <button className="btn-plan premium">Quiero Asesoria VIP</button>
            </SignUpButton>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="landing-footer">
        <img src="/vflogo.png" alt="CFanalisis" className="footer-logo" />
        <p>CFanalisis.com &mdash; Tu ventaja en cada apuesta</p>
        <div className="footer-links">
          <SignInButton mode="modal" forceRedirectUrl="/dashboard">
            <button className="footer-link-btn">Iniciar sesion</button>
          </SignInButton>
          <a href="#features">Funciones</a>
          <a href="#pricing">Precios</a>
        </div>
      </footer>
    </div>
  );
}
