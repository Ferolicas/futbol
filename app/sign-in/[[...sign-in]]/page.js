'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Globe2,
  LockKeyhole,
  LoaderCircle,
  Mail,
  Radio,
  ShieldCheck,
  Sparkles,
  Target,
} from 'lucide-react';
import {
  normalizePurchaseIntent,
  normalizePurchasePlan,
  purchasePlanLabel,
  purchaseRoute,
} from '../../../lib/purchase-flow';
import { useAuth } from '../../../components/providers';

export default function SignInPage() {
  const router = useRouter();
  const { refreshSession } = useAuth();
  const searchParams = useSearchParams();
  const selectedPlan = normalizePurchasePlan(searchParams.get('plan'));
  const purchaseIntent = normalizePurchaseIntent(searchParams.get('intent'));
  const selectedPlanLabel = purchasePlanLabel(selectedPlan);
  const signUpHref = purchaseRoute('/sign-up', 'plan', selectedPlan, purchaseIntent);
  const checkoutHref = purchaseRoute('/planes', 'checkout', selectedPlan, purchaseIntent);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Auth nativo PG: POST a /api/auth/login (setea cookie httpOnly JWT).
  // Antes: supabase.auth.signInWithPassword en el browser.
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setLoading(false);
        if (data.needsReset) {
          setError('Tu cuenta fue migrada. Usa "¿Olvidaste tu contraseña?" para crear una nueva.');
        } else {
          setError(data.error || 'Email o contraseña incorrectos');
        }
        return;
      }

      // La cookie ya existe; sincronizamos el contexto antes de navegar para
      // que nombre, avatar y estado por usuario aparezcan en el primer render.
      await refreshSession();
      router.replace(selectedPlan ? checkoutHref : '/dashboard');
    } catch {
      setLoading(false);
      setError('Error de red. Intenta de nuevo.');
    }
  };

  return (
    <div className="signup-page signin-page">
      <div className="signup-ambient" aria-hidden="true">
        <span className="signup-glow signup-glow-one" />
        <span className="signup-glow signup-glow-two" />
        <span className="signup-grid" />
      </div>

      <Link href="/" className="signup-back">
        <ArrowLeft size={17} aria-hidden="true" />
        Volver al inicio
      </Link>

      <main className="signup-shell signin-shell">
        <aside className="signup-value signin-value">
          <p className="signup-value-kicker">
            <Sparkles size={15} aria-hidden="true" />
            Tu panel te espera
          </p>
          <h2>Vuelve a los datos.<br /><span>Vuelve con ventaja.</span></h2>
          <p className="signup-value-copy">
            Entra a tu cuenta y continúa analizando cada partido desde el mismo lugar.
          </p>

          <ul className="signup-benefits">
            <li><span><Target size={17} aria-hidden="true" /></span> Apuesta del día inteligente</li>
            <li><span><Radio size={17} aria-hidden="true" /></span> Marcadores en vivo</li>
            <li><span><Globe2 size={17} aria-hidden="true" /></span> Más de 15 ligas</li>
          </ul>

          <div className="signup-value-note">
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <strong>Acceso protegido</strong>
              <span>Tu sesión utiliza una cookie segura.</span>
            </div>
          </div>
        </aside>

        <section className="signup-panel signin-panel">
          <header className="signup-header signin-header">
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

            <p className="signup-eyebrow">Acceso seguro</p>
            <h1>Bienvenido de vuelta</h1>
            <p>
              {selectedPlanLabel
                ? `Inicia sesión y continuaremos con el pago del Plan ${selectedPlanLabel}.`
                : 'Inicia sesión para volver a tu panel de análisis.'}
            </p>
          </header>

          <form onSubmit={handleSubmit} className="signup-form signin-form">
            <div className="signup-field">
              <label htmlFor="signin-email">Correo electrónico</label>
              <div className="signup-input">
                <Mail size={18} aria-hidden="true" />
                <input
                  id="signin-email"
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
              <div className="signin-label-row">
                <label htmlFor="signin-password">Contraseña</label>
                <Link href="/forgot-password">¿La olvidaste?</Link>
              </div>
              <div className="signup-input">
                <LockKeyhole size={18} aria-hidden="true" />
                <input
                  id="signin-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Introduce tu contraseña"
                  required
                  autoComplete="current-password"
                />
              </div>
            </div>

            {error && <p className="signup-error" role="alert">{error}</p>}

            <button type="submit" className="signup-submit" disabled={loading}>
              <span>{loading ? 'Iniciando sesión…' : 'Entrar a mi cuenta'}</span>
              {loading
                ? <LoaderCircle className="signup-loading-icon" size={18} aria-hidden="true" />
                : <ArrowRight size={18} aria-hidden="true" />}
            </button>
          </form>

          <p className="signup-footer">
            ¿Todavía no tienes cuenta?{' '}
            <Link href={signUpHref}>Regístrate</Link>
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
