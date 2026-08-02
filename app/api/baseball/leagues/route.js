/**
 * GET /api/baseball/leagues
 *
 * Grandes Ligas. MiLB no forma parte del producto porque no dispone del
 * catálogo Bet365 exigido para publicar recomendaciones apostables.
 */
export const dynamic = 'force-static';

const LEAGUES = [
  { id: 1, country: 'Estados Unidos', name: 'MLB', division: 1, type: 'season', flag: '🇺🇸' },
];

export async function GET() {
  return Response.json({ leagues: LEAGUES, total: LEAGUES.length });
}
