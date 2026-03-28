'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) setError('Enlace invalido. Solicita uno nuevo.');
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password.length < 6) {
      setError('La contrasena debe tener al menos 6 caracteres');
      return;
    }
    if (password !== confirm) {
      setError('Las contrasenas no coinciden');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Error al restablecer la contrasena');
      } else {
        setDone(true);
        setTimeout(() => router.push('/sign-in'), 3000);
      }
    } catch {
      setError('Error de conexion. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-bg" />
      <div className="login-container" style={{ maxWidth: '420px' }}>
        <div className="auth-card">
          <img src="/vflogo.png" alt="CFanalisis" className="auth-logo" />

          {done ? (
            <>
              <div style={{ textAlign: 'center', marginBottom: '8px', fontSize: '2.5rem' }}>&#9989;</div>
              <h1 className="auth-title">Contrasena actualizada</h1>
              <p className="auth-subtitle">
                Tu contrasena ha sido restablecida exitosamente. Redirigiendo al inicio de sesion...
              </p>
            </>
          ) : (
            <>
              <h1 className="auth-title">Nueva contrasena</h1>
              <p className="auth-subtitle">Elige una contrasena segura para tu cuenta.</p>

              <form onSubmit={handleSubmit} className="auth-form">
                <div className="auth-field">
                  <label>Nueva contrasena</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimo 6 caracteres"
                    required
                    minLength={6}
                    autoComplete="new-password"
                    disabled={!token}
                  />
                </div>
                <div className="auth-field">
                  <label>Confirmar contrasena</label>
                  <input
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Repite tu contrasena"
                    required
                    autoComplete="new-password"
                    disabled={!token}
                  />
                </div>
                {error && <p className="auth-error">{error}</p>}
                <button type="submit" className="auth-btn" disabled={loading || !token}>
                  {loading ? 'Guardando...' : 'Guardar nueva contrasena'}
                </button>
              </form>

              <p className="auth-footer-text">
                <Link href="/forgot-password" className="auth-link">Solicitar un nuevo enlace</Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div className="login-page">
        <div className="login-bg" />
        <div className="login-container" style={{ maxWidth: '420px' }}>
          <div className="auth-card" style={{ textAlign: 'center' }}>
            <p style={{ color: 'var(--t2)' }}>Cargando...</p>
          </div>
        </div>
      </div>
    }>
      <ResetPasswordForm />
    </Suspense>
  );
}
