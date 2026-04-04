'use client';
import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

function ResetPasswordForm() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tokenError, setTokenError] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  useEffect(() => {
    if (!token) setTokenError(true);
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) { setError('Las contraseñas no coinciden'); return; }
    if (password.length < 8) { setError('Mínimo 8 caracteres'); return; }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error al restablecer');
      setSuccess(true);
      setTimeout(() => router.push('/sign-in'), 2500);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-bg" />
      <div className="login-container" style={{ maxWidth: '420px' }}>
        <div className="auth-card">
          <Link href="/"><img src="/vflogo.png" alt="CFanalisis" className="auth-logo" style={{ cursor: 'pointer' }} /></Link>
          <h1 className="auth-title">Nueva contraseña</h1>
          <p className="auth-subtitle">Elige una contraseña segura para tu cuenta.</p>

          {success ? (
            <p style={{ color: '#10b981', textAlign: 'center', marginTop: '1rem' }}>
              ✓ Contraseña actualizada. Redirigiendo...
            </p>
          ) : tokenError ? (
            <div style={{ textAlign: 'center', marginTop: '1rem' }}>
              <p className="auth-error">Enlace inválido o expirado.</p>
              <Link href="/forgot-password" className="auth-link">Solicitar un nuevo enlace</Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="auth-form">
              <div className="auth-field">
                <label>Nueva contraseña</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Mínimo 8 caracteres"
                  required
                  autoFocus
                  autoComplete="new-password"
                />
              </div>
              <div className="auth-field">
                <label>Confirmar contraseña</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  placeholder="Repite la contraseña"
                  required
                  autoComplete="new-password"
                />
              </div>
              {error && <p className="auth-error">{error}</p>}
              <button type="submit" className="auth-btn" disabled={loading}>
                {loading ? 'Guardando...' : 'Guardar contraseña'}
              </button>
            </form>
          )}

          <p className="auth-footer-text" style={{ marginTop: '12px' }}>
            <Link href="/sign-in" className="auth-link">Volver al inicio de sesión</Link>
          </p>
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
          <div className="auth-card">
            <p style={{ color: '#64748b', textAlign: 'center' }}>Cargando...</p>
          </div>
        </div>
      </div>
    }>
      <ResetPasswordForm />
    </Suspense>
  );
}
