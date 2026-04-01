import { supabaseAdmin } from '../../../../lib/supabase';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';

export const dynamic = 'force-dynamic';

async function getAuthUser() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// GET — returns user's saved timezone
export async function GET() {
  try {
    const user = await getAuthUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await supabaseAdmin
      .from('user_profiles')
      .select('timezone')
      .eq('id', user.id)
      .single();

    if (error) {
      console.error('[user/timezone:GET]', error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ timezone: data?.timezone || 'UTC' });
  } catch (err) {
    console.error('[user/timezone:GET]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// PUT { timezone } — save user's timezone (detected from browser)
export async function PUT(request) {
  try {
    const user = await getAuthUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { timezone } = await request.json();
    if (!timezone) return Response.json({ error: 'timezone required' }, { status: 400 });

    // Validate it's a valid IANA timezone
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      return Response.json({ error: `Invalid timezone: ${timezone}` }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from('user_profiles')
      .update({ timezone })
      .eq('id', user.id);

    if (error) {
      console.error('[user/timezone:PUT]', error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: true, timezone });
  } catch (err) {
    console.error('[user/timezone:PUT]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
