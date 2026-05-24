/**
 * POST /api/auth-pg/logout — borra cookie + sesion DB
 */
import { logoutUser } from '../../../../lib/auth-pg';

export const dynamic = 'force-dynamic';

export async function POST() {
  await logoutUser();
  return Response.json({ ok: true });
}
