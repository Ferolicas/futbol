/**
 * GET /api/baseball/leagues
 *
 * Grandes Ligas + Triple-A (Bet365 SÍ publica cuota real ahí: hándicap ±1.5 y
 * una línea de total de carreras). El resto de MiLB (AA, A+, A, Rookie) no
 * forma parte del producto: sin verificación de que Bet365 las ofrezca.
 */
export const dynamic = 'force-static';

const LEAGUES = [
  { id: 1, country: 'Estados Unidos', name: 'MLB', division: 1, type: 'season', flag: '🇺🇸' },
  { id: 11, country: 'Estados Unidos', name: 'Triple-A', division: 1, type: 'season', flag: '🇺🇸' },
];

export async function GET() {
  return Response.json({ leagues: LEAGUES, total: LEAGUES.length });
}
