import { z } from 'zod';
import { pgPool } from '../../../../lib/db';
import { getCurrentUser } from '../../../../lib/auth-pg';
import { jsonError } from '../../../../lib/api-error';
import { deletePaperBet, setPaperLegResult } from '../../../../lib/paper-bets-store';

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();
const patchSchema = z.object({
  legId: z.string().uuid(),
  status: z.enum(['pending', 'won', 'lost', 'void']),
});

// PATCH — resultado a mano de una selección de esta apuesta.
export async function PATCH(request, props) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const params = await props.params;
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!uuid.safeParse(params.id).success || !parsed.success) {
      return Response.json({ error: 'Datos inválidos' }, { status: 400 });
    }
    const updated = await setPaperLegResult(pgPool, user.id, parsed.data.legId, parsed.data.status);
    if (!updated) return Response.json({ error: 'No encontrada' }, { status: 404 });
    return Response.json({ success: true });
  } catch (error) {
    console.error('[paper-bets:PATCH]', error.message);
    return jsonError(error);
  }
}

// DELETE — borra la apuesta y sus selecciones.
export async function DELETE(_request, props) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const params = await props.params;
    if (!uuid.safeParse(params.id).success) return Response.json({ error: 'Datos inválidos' }, { status: 400 });
    const deleted = await deletePaperBet(pgPool, user.id, params.id);
    if (!deleted) return Response.json({ error: 'No encontrada' }, { status: 404 });
    return Response.json({ success: true });
  } catch (error) {
    console.error('[paper-bets:DELETE]', error.message);
    return jsonError(error);
  }
}
