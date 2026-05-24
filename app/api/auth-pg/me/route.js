/**
 * GET /api/auth-pg/me — devuelve usuario logueado o 401
 */
import { getCurrentUser } from '../../../../lib/auth-pg';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  return Response.json({ user });
}
