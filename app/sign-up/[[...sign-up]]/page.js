'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
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
import BrandLogoMedia from '../../../components/BrandLogoMedia';
import { LEGAL_DOCUMENT_VERSION } from '../../../lib/legal-constants';

export default function SignUpPage() {
  const searchParams = useSearchParams();
  const selectedPlan = normalizePurchasePlan(searchParams.get('plan'));
  const purchaseIntent = normalizePurchaseIntent(searchParams.get('intent'));
  const selectedPlanLabel = purchasePlanLabel(selectedPlan);
  const signInHref = purchaseRoute('/sign-in', 'plan', selectedPlan, purchaseIntent);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [emailTaken, setEmailTaken] = useState(false);
  const [loading, setLoading] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  const [acceptAll, setAcceptAll] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);

  // Auth nativo PG: /api/register crea la cuenta y envía la verificación. La
  // sesión solo nace cuando el usuario demuestra control del correo.
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setEmailTaken(false);
    setLoading(true);

    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email,
          password,
          acceptAll,
          marketingConsent,
          legalVersion: LEGAL_DOCUMENT_VERSION,
          source: 'web',
          plan: selectedPlan,
          intent: purchaseIntent,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error || 'Error al registrarse');
        setEmailTaken(res.status === 409);
        setLoading(false);
        return;
      }

      setVerificationSent(true);
      setLoading(false);
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
            Crea tu cuenta y entra gratis a los cuatro deportes. Puedes mejorar a Pro cuando quieras.
          </p>

          <ul className="signup-benefits">
            <li><span><BarChart3 size={17} aria-hidden="true" /></span> Una recomendación gratis por evento elegible</li>
            <li><span><Check size={17} aria-hidden="true" /></span> Probabilidades de 60–70%</li>
            <li><span><Sparkles size={17} aria-hidden="true" /></span> Cuatro deportes en un solo lugar</li>
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
              <BrandLogoMedia
                className="signup-logo-video"
              />
            </Link>

            <div className="signup-journey" aria-label="Proceso de acceso">
              <span className="is-active"><strong>1</strong> Cuenta</span>
              <i aria-hidden="true" />
              <span><strong>2</strong> Acceso</span>
              <i aria-hidden="true" />
              <span><strong>3</strong> Analiza</span>
            </div>

            <p className="signup-eyebrow">Crea tu cuenta</p>
            <h1>Empieza con ventaja</h1>
            <p>
              {selectedPlanLabel
                ? `Entra gratis y elige el Plan ${selectedPlanLabel} si quieres acceso completo.`
                : 'Completa tus datos y empieza gratis. Sin tarjeta.'}
            </p>
          </header>

          {verificationSent ? (
            <div className="signup-form" style={{ textAlign: 'center' }}>
              <Check size={42} color="#00e676" aria-hidden="true" />
              <h2>Revisa tu correo</h2>
              <p>Enviamos un enlace seguro a <strong>{email}</strong>. Verifícalo para activar la cuenta y continuar.</p>
              <Link href={signInHref} className="signup-submit">Ir al inicio de sesión</Link>
            </div>
          ) : (
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
                  minLength={2}
                  maxLength={60}
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

            <label className="signup-legal-consent">
              <input
                type="checkbox"
                checked={acceptAll}
                onChange={(event) => setAcceptAll(event.target.checked)}
                required
              />
              <span>
                Soy mayor de 18 años, acepto los <Link href="/terminos" target="_blank">Términos</Link>,
                confirmo que leí la <Link href="/privacidad" target="_blank">Política de Privacidad</Link> y
                autorizo el tratamiento allí descrito. También leí la <Link href="/cookies" target="_blank">Política de Cookies</Link>.
              </span>
            </label>
            <label className="signup-legal-consent is-optional">
              <input
                type="checkbox"
                checked={marketingConsent}
                onChange={(event) => setMarketingConsent(event.target.checked)}
              />
              <span>Quiero recibir descuentos y novedades de CF Análisis. Es opcional y puedo retirarlo cuando quiera.</span>
            </label>

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
                    ? 'Crear cuenta y verificar correo'
                    : 'Crear cuenta y verificar correo'}
              </span>
              {loading
                ? <LoaderCircle className="signup-loading-icon" size={18} aria-hidden="true" />
                : <ArrowRight size={18} aria-hidden="true" />}
            </button>
          </form>
          )}

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
