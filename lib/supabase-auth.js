// Server-side auth helpers — Fase 2.5 hybrid.
//
// AUTH_PROVIDER env var:
//   - 'pg' (default tras switch) → usa lib/auth-pg.js (PG VPS nativo)
//   - 'supabase' o vacio          → usa @supabase/ssr (legacy, backward compat)
//
// El nombre del archivo se conserva (supabase-auth.js) y las funciones
// exportadas mantienen la misma signature para minimizar el blast radius
// del switch. Las llamadas como `createSupabaseServerClient()` en
// middleware/layouts siguen funcionando — solo cambia el backend.

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

const PROVIDER = process.env.AUTH_PROVIDER || 'supabase';

// ── Legacy Supabase path ───────────────────────────────────────────────────

function _createSupabaseServerClient() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {}
        },
      },
    }
  );
}

// ── Shim que emula la API de Supabase client cuando AUTH_PROVIDER=pg ──────
//
// Necesario para que createSupabaseServerClient().auth.getUser() siga
// funcionando en middleware.js, dashboard/layout.js, etc., sin tener
// que rewritear cada uno.
async function _pgGetUser() {
  const { getCurrentUser } = await import('./auth-pg');
  const u = await getCurrentUser();
  if (!u) return { data: { user: null }, error: null };
  // Devolver shape compatible con Supabase user
  return {
    data: {
      user: {
        id: u.id,
        email: u.email,
        email_confirmed_at: u.emailVerified ? new Date().toISOString() : null,
        user_metadata: { display_name: u.displayName },
      },
    },
    error: null,
  };
}

function _createPgShimClient() {
  return {
    auth: {
      async getUser()    { return await _pgGetUser(); },
      async getSession() {
        const r = await _pgGetUser();
        if (!r.data?.user) return { data: { session: null }, error: null };
        return { data: { session: { user: r.data.user } }, error: null };
      },
      // signOut → delegamos a logoutUser
      async signOut() {
        const { logoutUser } = await import('./auth-pg');
        await logoutUser();
        return { error: null };
      },
    },
  };
}

// ── Public API (mismo shape que antes) ────────────────────────────────────

export function createSupabaseServerClient() {
  if (PROVIDER === 'pg') return _createPgShimClient();
  return _createSupabaseServerClient();
}

export async function getSession() {
  const client = createSupabaseServerClient();
  const { data: { session }, error } = await client.auth.getSession();
  if (error) console.error('[auth:getSession]', error.message);
  return session;
}

export async function getUser() {
  const client = createSupabaseServerClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error) return null;
  return user;
}

export async function getUserProfile() {
  const user = await getUser();
  if (!user) return null;

  const { supabaseAdmin } = await import('./supabase');
  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (error) {
    console.error('[auth:getUserProfile]', error.message);
    return null;
  }
  return { ...user, ...data };
}
