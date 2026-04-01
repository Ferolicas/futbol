'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowserClient } from '../../lib/supabase-client';

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();

  useEffect(() => {
    // Supabase redirects here with recovery token in URL hash
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setReady(true);
    });
    // Also check current session
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setReady(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) { setError('Las contraseñas no coinciden'); return; }
    if (password.length < 8) { setError('Mínimo 8 caracteres'); return; }

    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setSuccess(true);
      setTimeout(() => router.push('/dashboard'), 2000);
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
        ) : !ready ? (
          <p style={{ color: '#64748b' }}>Verificando enlace de recuperación...</p>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required placeholder="Nueva contraseña (mín. 8 chars)" style={inputStyle} />
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
