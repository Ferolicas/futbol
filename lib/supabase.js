/**
 * lib/supabase.js — Post-migración (Fase 2.5 cerrada).
 *
 * Supabase fue ELIMINADO. Este archivo conserva el nombre y la export
 * `supabaseAdmin` para no romper los ~30 imports existentes, pero ahora
 * es 100% Postgres VPS:
 *
 *   supabaseAdmin.from('tabla')... → pgAdmin.from() (lib/db.js, pg directo)
 *   supabaseAdmin.rpc(fn, args)    → pgQuery('SELECT fn($1,...)')
 *   supabaseAdmin.auth / .storage  → throw (nada debería llamarlos ya;
 *                                     auth migró a lib/auth-pg.js)
 *
 * NO requiere ninguna env var de Supabase. Si algo aún llama .auth/.storage
 * lanzará un error claro indicando que esa ruta no migró.
 */

import { pgAdmin, pgQuery } from './db.js';

const supabaseRemoved = (what) => {
  throw new Error(
    `[supabase] ${what} ya no está disponible — Supabase fue eliminado. ` +
    `Auth usa lib/auth-pg.js; datos usan pgAdmin (lib/db.js).`,
  );
};

export const supabaseAdmin = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'from') return (table) => pgAdmin.from(table);
    if (prop === 'rpc') {
      // supabaseAdmin.rpc('fn', { a: 1 }) → SELECT fn($1) en PG.
      return async (fnName, args = {}) => {
        const keys = Object.keys(args || {});
        const params = keys.map((k) => args[k]);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        try {
          const { rows } = await pgQuery(`SELECT ${fnName}(${placeholders})`, params);
          return { data: rows, error: null };
        } catch (e) {
          return { data: null, error: { message: e.message, code: e.code || null } };
        }
      };
    }
    if (prop === 'auth')    return supabaseRemoved('supabaseAdmin.auth');
    if (prop === 'storage') return supabaseRemoved('supabaseAdmin.storage');
    // Cualquier otro acceso inesperado
    return undefined;
  },
});

// Compat: algunos módulos importaban estos. Devuelven el mismo proxy PG.
export const supabaseAnon = supabaseAdmin;

export function createSupabaseServerClient() {
  // Firma legacy conservada. Devuelve el proxy PG (solo .from/.rpc útiles).
  return supabaseAdmin;
}
