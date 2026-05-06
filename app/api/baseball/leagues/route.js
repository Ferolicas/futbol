import { BASEBALL_LEAGUES, BASEBALL_FLAGS } from '../../../../lib/baseball-leagues';

export const dynamic = 'force-static';

export async function GET() {
  const list = Object.entries(BASEBALL_LEAGUES).map(([id, meta]) => ({
    id: Number(id),
    ...meta,
    flag: BASEBALL_FLAGS[meta.country] || '🌍',
  }));
  return Response.json({ leagues: list, total: list.length });
}
