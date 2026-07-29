'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Check,
  LockKeyhole,
  LoaderCircle,
  Mail,
  ShieldCheck,
  Sparkles,
  UserRound,
} from 'lucide-react';
import {
  normalizePurchaseIntent,
  normalizePurchasePlan,
  purchasePlanLabel,
  purchaseRoute,
} from '../../../lib/purchase-flow';
import { useAuth } from '../../../components/providers';

export default function SignUpPage() {
  const router = useRouter();
  const { refreshSession } = useAuth();
  const searchParams = useSearchParams();
  const selectedPlan = normalizePurchasePlan(searchParams.get('plan'));
  const purchaseIntent = normalizePurchaseIntent(searchParams.get('intent'));
  const selectedPlanLabel = purchasePlanLabel(selectedPlan);
  const signInHref = purchaseRoute('/sign-in', 'plan', selectedPlan, purchaseIntent);
  const checkoutHref = purchaseRoute('/planes', 'checkout', selectedPlan, purchaseIntent);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [emailTaken, setEmailTaken] = useState(false);
  const [loading, setLoading] = useState(false);

  // Auth nativo PG: /api/register (signupUser) ya crea la sesión y setea la
  // cookie. No hace falta un segundo signInWithPassword. Antes el auto-login
  // se hacía con el browser client de Supabase.
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setEmailTaken(false);
    setLoading(true);

    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error || 'Error al registrarse');
        setEmailTaken(res.status === 409);
        setLoading(false);
        return;
      }

      // Sesión ya creada por signupUser. Si la compra nació en la Home,
      // conservamos únicamente el ID validado para abrir su checkout.
      await refreshSession();
      router.replace(checkoutHref);
    } catch {
      setError('Error al registrarse. Intenta de nuevo.');
      setLoading(false);
    }
  };

  return (
    <div className="signup-page">
      <div className="signup-ambient" aria-hidden="true">
        <span className="signup-glow signup-glow-one" />
        <span className="signup-glow signup-glow-two" />
        <span className="signup-grid" />
      </div>

      <Link href="/" className="signup-back">
        <ArrowLeft size={17} aria-hidden="true" />
        Volver al inicio
      </Link>

      <main className="signup-shell">
        <aside className="signup-value">
          <p className="signup-value-kicker">
            <Sparkles size={15} aria-hidden="true" />
            Tu ventaja empieza aquí
          </p>
          <h2>Decide con datos.<br /><span>No a ciegas.</span></h2>
          <p className="signup-value-copy">
            Crea tu cuenta y accede al siguiente paso para elegir el plan que mejor se adapte a ti.
          </p>

          <ul className="signup-benefits">
            <li><span><BarChart3 size={17} aria-hidden="true" /></span> Análisis estadístico completo</li>
            <li><span><Check size={17} aria-hidden="true" /></span> Combinadas inteligentes</li>
            <li><span><Sparkles size={17} aria-hidden="true" /></span> Más de 15 ligas</li>
          </ul>

          <div className="signup-value-note">
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <strong>Registro seguro</strong>
              <span>Tus credenciales viajan protegidas.</span>
            </div>
          </div>
        </aside>

        <section className="signup-panel">
          <header className="signup-header">
            <Link href="/" className="signup-logo-link" aria-label="Volver a CF Análisis">
              <video
                className="signup-logo-video"
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                aria-label="CF Análisis"
              >
                <source src="/logo-metalizado.webm" type="video/webm" />
              </video>
            </Link>

            <div className="signup-journey" aria-label="Proceso de acceso">
              <span className="is-active"><strong>1</strong> Cuenta</span>
              <i aria-hidden="true" />
              <span><strong>2</strong> Plan</span>
              <i aria-hidden="true" />
              <span><strong>3</strong> Analiza</span>
            </div>

            <p className="signup-eyebrow">Crea tu cuenta</p>
            <h1>Empieza con ventaja</h1>
            <p>
              {selectedPlanLabel
                ? `Completa tus datos y abriremos el pago del Plan ${selectedPlanLabel}.`
                : 'Completa tus datos. En el siguiente paso podrás elegir tu plan.'}
            </p>
          </header>

          <form onSubmit={handleSubmit} className="signup-form">
            <div className="signup-field">
              <label htmlFor="signup-name">Nombre</label>
              <div className="signup-input">
                <UserRound size={18} aria-hidden="true" />
                <input
                  id="signup-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Tu nombre"
                  required
                  autoComplete="name"
                />
              </div>
            </div>

            <div className="signup-field">
              <label htmlFor="signup-email">Correo electrónico</label>
              <div className="signup-input">
                <Mail size={18} aria-hidden="true" />
                <input
                  id="signup-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="tu@correo.com"
                  required
                  autoComplete="email"
                />
              </div>
            </div>

            <div className="signup-field">
              <label htmlFor="signup-password">Contraseña</label>
              <div className="signup-input">
                <LockKeyhole size={18} aria-hidden="true" />
                <input
                  id="signup-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Mínimo 8 caracteres"
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
              </div>
              <p className="signup-field-hint">Usa al menos 8 caracteres.</p>
            </div>

            {error && (
              <div className="signup-error" role="alert">
                <span>{error}</span>
                {emailTaken && (
                  <Link href={signInHref} className="signup-error-link">
                    {selectedPlan
                      ? 'Inicia sesión para continuar con este plan'
                      : 'Inicia sesión para continuar'}
                  </Link>
                )}
              </div>
            )}

            <button type="submit" className="signup-submit" disabled={loading}>
              <span>
                {loading
                  ? 'Creando cuenta…'
                  : selectedPlan
                    ? 'Continuar al pago'
                    : 'Continuar'}
              </span>
              {loading
                ? <LoaderCircle className="signup-loading-icon" size={18} aria-hidden="true" />
                : <ArrowRight size={18} aria-hidden="true" />}
            </button>
          </form>

          <p className="signup-footer">
            ¿Ya tienes una cuenta?{' '}
            <Link href={signInHref}>Inicia sesión</Link>
          </p>

          <p className="signup-privacy">
            <ShieldCheck size={14} aria-hidden="true" />
            Conexión segura y datos protegidos
          </p>
        </section>
      </main>
    </div>
  );
}
