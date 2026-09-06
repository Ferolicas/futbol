import { createSupabaseServerClient } from '../../../../lib/supabase-auth';

export async function GET() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ redirect: '/sign-in' });
  }

  return Response.json({ redirect: '/dashboard' });
}
