// Server-side Supabase auth helpers
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export function createSupabaseServerClient() {
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

export async function getSession() {
  const supabase = createSupabaseServerClient();
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) console.error('[supabase-auth:getSession]', error.message);
  return session;
}

export async function getUser() {
  const supabase = createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
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
    console.error('[supabase-auth:getUserProfile]', error.message);
    return null;
  }
  return { ...user, ...data };
}
