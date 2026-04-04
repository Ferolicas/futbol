'use client';
import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

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

  const inputStyle = {
    width: '100%', padding: '0.75rem 1rem', background: '#1a2332',
    border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px',
    color: '#f1f5f9', fontSize: '1rem', outline: 'none', boxSizing: 'border-box',
  };

  return (
    <div style={{ minHeight: '100vh', background: '#0a0e17', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ background: 'rgba(17,24,39,0.8)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '16px', padding: '2rem', width: '100%', maxWidth: '400px' }}>
        <h1 style={{ color: '#22d3ee', fontSize: '1.5rem', fontWeight: 700, marginTop: 0 }}>Nueva contraseña</h1>

        {success ? (
          <p style={{ color: '#10b981' }}>✓ Contraseña actualizada. Redirigiendo...</p>
        ) : tokenError ? (
          <>
            <p style={{ color: '#ef4444' }}>Enlace inválido o expirado.</p>
            <a href="/forgot-password" style={{ color: '#22d3ee', fontSize: '0.9rem' }}>Solicitar un nuevo enlace</a>
          </>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required placeholder="Nueva contraseña (mín. 8 chars)" style={inputStyle} autoFocus />
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required placeholder="Confirmar contraseña" style={inputStyle} />
            {error && <p style={{ color: '#ef4444', margin: 0, fontSize: '0.85rem' }}>{error}</p>}
            <button type="submit" disabled={loading} style={{ padding: '0.875rem', background: '#22d3ee', color: '#0a0e17', border: 'none', borderRadius: '8px', fontWeight: 600, cursor: 'pointer' }}>
              {loading ? 'Guardando...' : 'Guardar contraseña'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: '100vh', background: '#0a0e17', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#64748b', fontFamily: 'system-ui' }}>Cargando...</p>
      </div>
    }>
      <ResetPasswordForm />
    </Suspense>
  );
}
