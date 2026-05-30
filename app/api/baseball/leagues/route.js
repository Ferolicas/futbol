/**
 * GET /api/baseball/leagues
 *
 * MLB-only. La integración con api-sports (NPB, KBO, LMB, ligas de invierno
 * caribeñas) se purgó en la migración a MLB Stats API. Devolvemos un único
 * item — MLB — preservando el shape que la UI ya consume: { leagues, total }.
 */
export const dynamic = 'force-static';

const LEAGUES = [
  { id: 1, country: 'USA', name: 'MLB', division: 1, type: 'season', flag: '🇺🇸' },
];

export async function GET() {
  return Response.json({ leagues: LEAGUES, total: LEAGUES.length });
}
