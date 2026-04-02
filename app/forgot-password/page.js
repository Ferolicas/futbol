'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Error al enviar el correo');
      } else {
        setSent(true);
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
          <Link href="/"><img src="/vflogo.png" alt="CFanalisis" className="auth-logo" style={{ cursor: 'pointer' }} /></Link>

          {sent ? (
            <>
              <div style={{ textAlign: 'center', marginBottom: '8px', fontSize: '2.5rem' }}>&#128231;</div>
              <h1 className="auth-title">Revisa tu correo</h1>
              <p className="auth-subtitle">
                Si tu email esta registrado, recibiras un enlace para restablecer tu contrasena en los proximos minutos.
              </p>
              <p className="auth-footer-text">
                <Link href="/sign-in" className="auth-link">Volver al inicio de sesion</Link>
              </p>
            </>
          ) : (
            <>
              <h1 className="auth-title">Restablecer contrasena</h1>
              <p className="auth-subtitle">
                Ingresa tu email y te enviaremos un enlace para crear una nueva contrasena.
              </p>

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
                {error && <p className="auth-error">{error}</p>}
                <button type="submit" className="auth-btn" disabled={loading}>
                  {loading ? 'Enviando...' : 'Enviar enlace'}
                </button>
              </form>

              <p className="auth-footer-text">
                <Link href="/sign-in" className="auth-link">Volver al inicio de sesion</Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
