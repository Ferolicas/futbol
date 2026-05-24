'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function SignUpPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Auth nativo PG: /api/register (signupUser) ya crea la sesión y setea la
  // cookie. No hace falta un segundo signInWithPassword. Antes el auto-login
  // se hacía con el browser client de Supabase.
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
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
        setLoading(false);
        return;
      }

      // Sesión ya creada por signupUser → ir directo a planes.
      router.replace('/planes');
    } catch {
      setError('Error al registrarse. Intenta de nuevo.');
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-bg" />
      <div className="login-container" style={{ maxWidth: '420px' }}>
        <div className="auth-card">
          <Link href="/"><img src="/vflogo.png" alt="CFanalisis" className="auth-logo" style={{ cursor: 'pointer' }} /></Link>
          <h1 className="auth-title">Crear cuenta en CF Analisis</h1>
          <p className="auth-subtitle">Bienvenido! Completa los datos para registrarte.</p>

          <form onSubmit={handleSubmit} className="auth-form">
            <div className="auth-field">
              <label>Nombre</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Tu nombre"
                required
                autoComplete="name"
              />
            </div>
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
                placeholder="Minimo 6 caracteres"
                required
                minLength={6}
                autoComplete="new-password"
              />
            </div>
            {error && <p className="auth-error">{error}</p>}
            <button type="submit" className="auth-btn" disabled={loading}>
              {loading ? 'Creando cuenta...' : 'Continuar'}
            </button>
          </form>

          <p className="auth-footer-text">
            Ya tienes una cuenta?{' '}
            <Link href="/sign-in" className="auth-link">Inicia sesion</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
