/**
 * GET /api/baseball/leagues
 *
 * Grandes Ligas y niveles oficiales de MiLB publicados por MLB Stats API.
 */
export const dynamic = 'force-static';

const LEAGUES = [
  { id: 1, country: 'Estados Unidos', name: 'MLB', division: 1, type: 'season', flag: '🇺🇸' },
  { id: 11, country: 'Estados Unidos', name: 'Triple-A', division: 2, type: 'season', flag: '🇺🇸' },
  { id: 12, country: 'Estados Unidos', name: 'Double-A', division: 3, type: 'season', flag: '🇺🇸' },
  { id: 13, country: 'Estados Unidos', name: 'High-A', division: 4, type: 'season', flag: '🇺🇸' },
  { id: 14, country: 'Estados Unidos', name: 'Single-A', division: 5, type: 'season', flag: '🇺🇸' },
  { id: 16, country: 'Estados Unidos', name: 'Rookie', division: 6, type: 'season', flag: '🇺🇸' },
];

export async function GET() {
  return Response.json({ leagues: LEAGUES, total: LEAGUES.length });
}
