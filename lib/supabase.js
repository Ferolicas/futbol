import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) throw new Error('[SUPABASE] NEXT_PUBLIC_SUPABASE_URL is not set');

// Admin client — bypasses RLS, use only in API routes and server components
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Anon client — respects RLS, use for browser-side operations
export const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey);

// Create a server-side client that uses a user's access token (for RLS)
export function createSupabaseServerClient(accessToken) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
