/**
 * lib/supabase.js
 *
 * Hybrid: Supabase Auth se conserva intacto (login, sesiones, /auth/*),
 * pero `supabaseAdmin.from(...)` ahora apunta al Postgres del VPS via `pg`.
 *
 *   supabaseAdmin.from('tabla')...           → ejecuta SQL en el VPS (pg)
 *   supabaseAdmin.auth.admin.createUser(...) → sigue yendo a Supabase Auth
 *   supabaseAdmin.auth.admin.updateUserById  → idem
 *
 * Esto permite migrar las tablas de datos al VPS sin romper auth.
 */

import { createClient } from '@supabase/supabase-js';
import { pgAdmin } from './db.js';

const supabaseUrl        = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) throw new Error('[SUPABASE] NEXT_PUBLIC_SUPABASE_URL is not set');

// Cliente Supabase real — solo se usa para .auth.admin.* y .auth.getUser
const _supabaseAuthClient = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Proxy híbrido: from/rpc → pg, auth → Supabase
export const supabaseAdmin = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'from')    return (table) => pgAdmin.from(table);
    if (prop === 'auth')    return _supabaseAuthClient.auth;
    if (prop === 'storage') return _supabaseAuthClient.storage;
    if (prop === 'rpc')     return _supabaseAuthClient.rpc.bind(_supabaseAuthClient);
    // Fallback: delegar al cliente real (compat con cualquier acceso no previsto)
    const v = _supabaseAuthClient[prop];
    return typeof v === 'function' ? v.bind(_supabaseAuthClient) : v;
  },
});

// Anon client — sigue siendo Supabase (solo se usa para auth client-side)
export const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey);

// Crea un cliente Supabase ligado a un access_token de usuario (para validar sesión)
export function createSupabaseServerClient(accessToken) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
