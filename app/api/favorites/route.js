import { supabaseAdmin } from '../../../lib/supabase';
import { createSupabaseServerClient } from '../../../lib/supabase-auth';
import { pgQuery } from '../../../lib/db';
import { jsonError } from '../../../lib/api-error';
import {
  ALL_FOOTBALL_NOTIFICATION_PREFERENCES,
  normalizeFootballNotificationPreferences,
} from '../../../lib/football-notification-preferences';

export const dynamic = 'force-dynamic';

async function getAuthUser() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// GET — list all favorites for the current user
export async function GET() {
  try {
    const user = await getAuthUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await supabaseAdmin
      .from('user_favorites')
      .select('fixture_id, notification_preferences, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[favorites:GET]', error.message);
      return jsonError(error);
    }

    return Response.json({
      favorites: data.map(r => r.fixture_id),
      notificationPreferences: Object.fromEntries(data.map((row) => [
        row.fixture_id,
        normalizeFootballNotificationPreferences(row.notification_preferences),
      ])),
    });
  } catch (err) {
    console.error('[favorites:GET]', err.message);
    return jsonError(err);
  }
}

// POST { fixtureId, notificationPreferences } — add/update favorite
export async function POST(request) {
  try {
    const user = await getAuthUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { fixtureId, notificationPreferences = [] } = await request.json();
    if (!fixtureId) return Response.json({ error: 'fixtureId required' }, { status: 400 });
    if (!Array.isArray(notificationPreferences)) {
      return Response.json({ error: 'notificationPreferences must be an array' }, { status: 400 });
    }

    const normalizedPreferences = normalizeFootballNotificationPreferences(notificationPreferences);
    if (notificationPreferences.some((value) => !ALL_FOOTBALL_NOTIFICATION_PREFERENCES.includes(value))) {
      return Response.json({ error: 'notificationPreferences contains invalid values' }, { status: 400 });
    }

    // El adaptador legacy serializa arrays como JSON porque la mayoría de sus
    // destinos son jsonb. Esta columna es TEXT[] nativa: pg debe recibir el
    // array directamente (con cast explícito), no el literal JSON `["..."]`.
    await pgQuery(
      `INSERT INTO public.user_favorites (user_id, fixture_id, notification_preferences)
       VALUES ($1, $2, $3::text[])
       ON CONFLICT (user_id, fixture_id)
       DO UPDATE SET notification_preferences = EXCLUDED.notification_preferences`,
      [user.id, Number(fixtureId), normalizedPreferences],
    );

    return Response.json({ success: true, fixtureId, notificationPreferences: normalizedPreferences });
  } catch (err) {
    console.error('[favorites:POST]', err.message);
    return jsonError(err);
  }
}

// DELETE { fixtureId } — remove from favorites
export async function DELETE(request) {
  try {
    const user = await getAuthUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { fixtureId } = await request.json();
    if (!fixtureId) return Response.json({ error: 'fixtureId required' }, { status: 400 });

    const { error } = await supabaseAdmin
      .from('user_favorites')
      .delete()
      .eq('user_id', user.id)
      .eq('fixture_id', Number(fixtureId));

    if (error) {
      console.error('[favorites:DELETE]', error.message);
      return jsonError(error);
    }

    return Response.json({ success: true, fixtureId });
  } catch (err) {
    console.error('[favorites:DELETE]', err.message);
    return jsonError(err);
  }
}
