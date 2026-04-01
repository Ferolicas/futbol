'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowserClient } from '../../lib/supabase-client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('login'); // 'login' | 'signup' | 'forgot'
  const [message, setMessage] = useState('');
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);

    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push('/dashboard');
        router.refresh();
      } else if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/dashboard` },
        });
        if (error) throw error;
        setMessage('Revisa tu email para confirmar tu cuenta.');
      } else if (mode === 'forgot') {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) throw error;
        setMessage('Se envió un enlace de recuperación a tu email.');
      }
    } catch (err) {
      setError(err.message || 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0e17',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '1rem',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{
        background: 'rgba(17,24,39,0.8)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '16px',
        padding: '2rem',
        width: '100%',
        maxWidth: '400px',
        backdropFilter: 'blur(12px)',
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <h1 style={{ color: '#22d3ee', fontSize: '1.8rem', fontWeight: 700, margin: 0 }}>CF Análisis</h1>
          <p style={{ color: '#64748b', fontSize: '0.9rem', marginTop: '0.25rem' }}>
            {mode === 'login' ? 'Inicia sesión' : mode === 'signup' ? 'Crear cuenta' : 'Recuperar contraseña'}
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={{ color: '#94a3b8', fontSize: '0.85rem', display: 'block', marginBottom: '0.4rem' }}>
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              style={{
                width: '100%',
                padding: '0.75rem 1rem',
                background: '#1a2332',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                color: '#f1f5f9',
                fontSize: '1rem',
                outline: 'none',
                boxSizing: 'border-box',
              }}
              placeholder="tu@email.com"
            />
          </div>

          {mode !== 'forgot' && (
            <div>
              <label style={{ color: '#94a3b8', fontSize: '0.85rem', display: 'block', marginBottom: '0.4rem' }}>
                Contraseña
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={8}
                style={{
                  width: '100%',
                  padding: '0.75rem 1rem',
                  background: '#1a2332',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '8px',
                  color: '#f1f5f9',
                  fontSize: '1rem',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
                placeholder="••••••••"
              />
            </div>
          )}

          {error && (
            <p style={{ color: '#ef4444', fontSize: '0.85rem', margin: 0 }}>{error}</p>
          )}
          {message && (
            <p style={{ color: '#10b981', fontSize: '0.85rem', margin: 0 }}>{message}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              padding: '0.875rem',
              background: loading ? '#1a2332' : '#22d3ee',
              color: loading ? '#64748b' : '#0a0e17',
              border: 'none',
              borderRadius: '8px',
              fontSize: '1rem',
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {loading ? 'Cargando...' : mode === 'login' ? 'Entrar' : mode === 'signup' ? 'Crear cuenta' : 'Enviar enlace'}
          </button>
        </form>

        {/* Mode switchers */}
        <div style={{ marginTop: '1.5rem', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {mode === 'login' && (
            <>
              <button onClick={() => setMode('forgot')} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '0.85rem' }}>
                ¿Olvidaste tu contraseña?
              </button>
              <button onClick={() => setMode('signup')} style={{ background: 'none', border: 'none', color: '#22d3ee', cursor: 'pointer', fontSize: '0.85rem' }}>
                Crear cuenta nueva
              </button>
            </>
          )}
          {(mode === 'signup' || mode === 'forgot') && (
            <button onClick={() => setMode('login')} style={{ background: 'none', border: 'none', color: '#22d3ee', cursor: 'pointer', fontSize: '0.85rem' }}>
              ← Volver al login
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
