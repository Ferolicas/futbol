'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function SignInPage() {
  const router = useRouter();
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

      router.replace('/dashboard');
    } catch {
      setLoading(false);
      setError('Error de red. Intenta de nuevo.');
    }
  };

  return (
    <div className="login-page">
      <div className="login-bg" />
      <div className="login-container" style={{ maxWidth: '420px' }}>
        <div className="auth-card">
          <Link href="/"><img src="/vflogo.png" alt="CFanalisis" className="auth-logo" style={{ cursor: 'pointer' }} /></Link>
          <h1 className="auth-title">Iniciar sesion en CF Analisis</h1>
          <p className="auth-subtitle">Bienvenido de vuelta. Inicia sesion para continuar.</p>

          <form onSubmit={handleSubmit} className="auth-form">
            <div className="auth-field">
              <label>Correo electronico</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Introduce tu correo electronico"
                required
                autoComplete="email"
              />
            </div>
            <div className="auth-field">
              <label>Contrasena</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Introduce tu contrasena"
                required
                autoComplete="current-password"
              />
            </div>
            {error && <p className="auth-error">{error}</p>}
            <button type="submit" className="auth-btn" disabled={loading}>
              {loading ? 'Iniciando sesion...' : 'Continuar'}
            </button>
          </form>

          <p className="auth-footer-text" style={{ marginTop: '12px' }}>
            <Link href="/forgot-password" className="auth-link">Olvidaste tu contrasena?</Link>
          </p>
          <p className="auth-footer-text">
            No tienes una cuenta?{' '}
            <Link href="/sign-up" className="auth-link">Registrate</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
