'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, LoaderCircle, ShieldCheck } from 'lucide-react';
import BrandLogoMedia from '../../components/BrandLogoMedia';
import { normalizePurchaseIntent, normalizePurchasePlan, purchaseRoute } from '../../lib/purchase-flow';

export default function VerifyEmailPage() {
  const router = useRouter();
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('Verificando tu correo…');

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!token) {
      setStatus('error');
      setMessage('El enlace es inválido o ya expiró.');
      return;
    }
    fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'No se pudo verificar el correo.');
      setStatus('success');
      setMessage('Correo verificado. Tu cuenta ya está activa.');
      const params = new URLSearchParams(window.location.search);
      const plan = normalizePurchasePlan(params.get('plan'));
      const intent = normalizePurchaseIntent(params.get('intent'));
      const destination = purchaseRoute('/dashboard', 'plan', plan, intent);
      window.setTimeout(() => router.replace(destination), 1600);
    }).catch((error) => {
      setStatus('error');
      setMessage(error.message || 'No se pudo verificar el correo.');
    });
  }, [router]);

  return (
    <div className="login-page">
      <div className="login-bg" />
      <div className="login-container" style={{ maxWidth: '420px' }}>
        <div className="auth-card" style={{ textAlign: 'center' }}>
          <Link href="/"><BrandLogoMedia className="auth-logo" /></Link>
          {status === 'loading' && <LoaderCircle className="signup-loading-icon" size={36} aria-hidden="true" />}
          {status === 'success' && <CheckCircle2 size={42} color="#00e676" aria-hidden="true" />}
          {status === 'error' && <ShieldCheck size={42} color="#fb7185" aria-hidden="true" />}
          <h1 className="auth-title">Verificación de correo</h1>
          <p className={status === 'error' ? 'auth-error' : 'auth-subtitle'}>{message}</p>
          {status === 'error' && <Link href="/sign-in" className="auth-link">Volver al inicio de sesión</Link>}
        </div>
      </div>
    </div>
  );
}
