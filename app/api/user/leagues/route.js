import { supabaseAdmin } from '../../../../lib/supabase';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { pgPool } from '../../../../lib/db';
import { ALL_LEAGUE_IDS } from '../../../../lib/leagues';
import { jsonError } from '../../../../lib/api-error';

export const dynamic = 'force-dynamic';

async function getAuthUser() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// Preferencia VISUAL exclusivamente. No modifica las ligas que analizan los
// workers ni el calendario global. NULL = todas; [] = ninguna; [ids] = custom.
export async function GET() {
  try {
    const user = await getAuthUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile, error } = await supabaseAdmin
      .from('user_profiles')
      .select('custom_league_ids')
      .eq('id', user.id)
      .single();

    if (error) {
      console.error('[user/leagues:GET]', error.message);
      return jsonError(error);
    }

    const isCustom = Array.isArray(profile?.custom_league_ids);
    const leagueIds = isCustom ? profile.custom_league_ids.map(Number) : ALL_LEAGUE_IDS;

    return Response.json({ leagueIds, isCustom });
  } catch (err) {
    console.error('[user/leagues:GET]', err.message);
    return jsonError(err);
  }
}

// PUT { leagueIds: number[] | null } — null=todas, []=ninguna, [ids]=custom.
export async function PUT(request) {
  try {
    const user = await getAuthUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { leagueIds } = await request.json();
    if (leagueIds !== null && !Array.isArray(leagueIds)) {
      return Response.json({ error: 'leagueIds debe ser un arreglo o null' }, { status: 400 });
    }
    if (leagueIds?.length > ALL_LEAGUE_IDS.length) {
      return Response.json({ error: 'La selección supera el máximo de ligas disponible' }, { status: 400 });
    }

    const requested = leagueIds === null ? null : leagueIds.map(Number);
    if (requested?.some(id => !Number.isInteger(id) || !ALL_LEAGUE_IDS.includes(id))) {
      return Response.json({ error: 'La selección contiene una liga no válida' }, { status: 400 });
    }
    const validIds = requested === null ? null : [...new Set(requested)];

    // Query directa para que pg serialice INTEGER[] de forma nativa. El
    // adaptador legacy convierte arreglos JS a JSON porque normalmente escribe
    // JSONB; usarlo aquí rompería precisamente el estado vacío `[]`.
    const result = await pgPool.query(
      `UPDATE user_profiles
       SET custom_league_ids = $1::integer[], updated_at = NOW()
       WHERE id = $2
       RETURNING custom_league_ids`,
      [validIds, user.id],
    );
    if (result.rowCount !== 1) {
      return Response.json({ error: 'Perfil de usuario no encontrado' }, { status: 404 });
    }

    return Response.json({ success: true, leagueIds: validIds, isCustom: validIds !== null });
  } catch (err) {
    console.error('[user/leagues:PUT]', err.message);
    return jsonError(err);
  }
}
