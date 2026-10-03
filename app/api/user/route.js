/**
 * /api/user
 * User data: hidden, analyzed, combinadas — all via Supabase.
 */
import { createSupabaseServerClient } from '../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../lib/supabase';
import { redisGet, redisSet, KEYS } from '../../../lib/redis';
import { jsonError } from '../../../lib/api-error';
import { redisRateLimit } from '../../../lib/ratelimit-redis';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
const HIDDEN_TTL = 30 * 24 * 3600;
const writeSchema = z.object({
  type: z.enum(['hide', 'unhide', 'save-combinada', 'delete-combinada']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  data: z.record(z.string(), z.unknown()),
}).strict();

async function requireUser(supabase) {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// GET: Get user-specific data
export async function GET(request) {
  const supabase = createSupabaseServerClient();
  const user = await requireUser(supabase);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const userId = user.id;

  try {
    if (type === 'hidden') {
      const cached = await redisGet(KEYS.userHidden(userId));
      if (Array.isArray(cached)) return Response.json({ hidden: cached });
      const { data } = await supabaseAdmin.from('user_hidden').select('fixture_id').eq('user_id', userId);
      const ids = (data || []).map(r => r.fixture_id);
      if (ids.length > 0) redisSet(KEYS.userHidden(userId), ids, HIDDEN_TTL).catch(() => {});
      return Response.json({ hidden: ids });
    }

    if (type === 'combinadas') {
      const { data, error } = await supabaseAdmin
        .from('combinadas')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error?.code === '42P01') return Response.json({ combinadas: [] });
      if (error) console.error('[user:combinadas]', error.message);
      return Response.json({ combinadas: data || [] });
    }

    return Response.json({ error: 'Invalid type parameter' }, { status: 400 });
  } catch (error) {
    console.error('[user:GET]', error.message);
    return jsonError(error);
  }
}

// POST: Save user-specific data
export async function POST(request) {
  const supabase = createSupabaseServerClient();
  const user = await requireUser(supabase);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const limit = await redisRateLimit('user-write', user.id, 30, 60, { failClosed: true });
  if (!limit.success) return Response.json({ error: 'Demasiadas solicitudes.' }, { status: 429 });
  const parsed = writeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Solicitud inválida' }, { status: 400 });
  const { type, data, date: clientDate } = parsed.data;
  const userId = user.id;
  const date = clientDate || new Date().toISOString().split('T')[0];

  try {
    if (type === 'hide') {
      const { error: hideErr } = await supabaseAdmin.from('user_hidden').upsert(
        { user_id: userId, fixture_id: Number(data.fixtureId), date },
        { onConflict: 'user_id,fixture_id' }
      );
      // M-2 FIX: pgAdmin devuelve {error} sin lanzar. Antes el fallo se tragaba y
      // el usuario recibía 200 con una lista que no reflejaba su cambio.
      if (hideErr) {
        console.error('[user:hide]', { userId, fixtureId: Number(data.fixtureId), error: hideErr.message });
        return Response.json({ error: 'No se pudo guardar el cambio' }, { status: 500 });
      }
      await redisSet(KEYS.userHidden(userId), null, 1).catch(() => {});
      const { data: rows } = await supabaseAdmin.from('user_hidden').select('fixture_id').eq('user_id', userId);
      const ids = (rows || []).map(r => r.fixture_id);
      await redisSet(KEYS.userHidden(userId), ids, HIDDEN_TTL).catch(() => {});
      return Response.json({ hidden: ids });
    }

    if (type === 'unhide') {
      const { error: unhideErr } = await supabaseAdmin.from('user_hidden').delete().eq('user_id', userId).eq('fixture_id', Number(data.fixtureId));
      // M-2 FIX: leer el {error} del delete (pgAdmin no lanza) y no fingir éxito.
      if (unhideErr) {
        console.error('[user:unhide]', { userId, fixtureId: Number(data.fixtureId), error: unhideErr.message });
        return Response.json({ error: 'No se pudo guardar el cambio' }, { status: 500 });
      }
      await redisSet(KEYS.userHidden(userId), null, 1).catch(() => {});
      const { data: rows } = await supabaseAdmin.from('user_hidden').select('fixture_id').eq('user_id', userId);
      const ids = (rows || []).map(r => r.fixture_id);
      await redisSet(KEYS.userHidden(userId), ids, HIDDEN_TTL).catch(() => {});
      return Response.json({ hidden: ids });
    }

    if (type === 'save-combinada') {
      if (!Array.isArray(data.selections) || data.selections.length < 1 || data.selections.length > 20) {
        return Response.json({ error: 'La combinada debe tener entre 1 y 20 selecciones.' }, { status: 400 });
      }
      if (typeof data.name !== 'string' || data.name.trim().length < 1 || data.name.length > 100) {
        return Response.json({ error: 'Nombre de combinada inválido.' }, { status: 400 });
      }
      const normalizedSelections = (data.selections || []).map(s => ({
        fixtureId: String(s?.fixtureId || '').slice(0, 40),
        matchName: String(s?.matchName || '').slice(0, 160),
        market: String(s?.name || s?.market || '').slice(0, 160),
        odd: Math.max(0, Math.min(10000, Number(s?.odd) || 0)),
        probability: Math.max(0, Math.min(100, Number(s?.probability) || 0)),
      }));

      const { data: row, error } = await supabaseAdmin.from('combinadas').insert({
        user_id: userId,
        name: data.name.trim(),
        selections: normalizedSelections,
        combined_odd: data.combinedOdd,
        combined_probability: data.combinedProbability,
        created_at: new Date().toISOString(),
      }).select('id').single();

      if (error) {
        if (error.code === '42P01') return Response.json({ error: 'Servicio no disponible temporalmente.' }, { status: 503 });
        console.error('[user:save-combinada]', error.message);
        return Response.json({ error: 'Error saving combinada' }, { status: 500 });
      }
      return Response.json({ success: true, id: row.id });
    }

    if (type === 'delete-combinada') {
      const combinadaId = String(data.combinadaId || '');
      if (!/^[0-9a-f-]{1,80}$/i.test(combinadaId)) return Response.json({ error: 'combinadaId required' }, { status: 400 });
      const { error } = await supabaseAdmin
        .from('combinadas')
        .delete()
        .eq('id', combinadaId)
        .eq('user_id', userId);
      // M-2 FIX: antes solo logueaba y devolvía success aunque el delete fallara
      // (mismo patrón de fallo silencioso). Ahora propaga el error.
      if (error) {
        console.error('[user:delete-combinada]', { userId, combinadaId, error: error.message });
        return Response.json({ error: 'No se pudo eliminar la combinada' }, { status: 500 });
      }
      return Response.json({ success: true });
    }

    return Response.json({ error: 'Invalid type' }, { status: 400 });
  } catch (error) {
    console.error('[user:POST]', error.message);
    return jsonError(error);
  }
}
