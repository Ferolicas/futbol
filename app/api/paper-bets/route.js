import { z } from 'zod';
import { pgPool } from '../../../lib/db';
import { getCurrentUser } from '../../../lib/auth-pg';
import { jsonError } from '../../../lib/api-error';
import { redisRateLimit } from '../../../lib/ratelimit-redis';
import { analyzeLegs, summarizeBets } from '../../../lib/paper-bets';
import { createPaperBet, listPaperBets, settlePendingPaperBets } from '../../../lib/paper-bets-store';

export const dynamic = 'force-dynamic';

const legSchema = z.object({
  sport: z.enum(['football', 'baseball', 'basketball', 'american_football']),
  source: z.enum(['recommended', 'manual']).default('recommended'),
  id: z.union([z.string(), z.number()]).optional().nullable(),
  fixtureId: z.union([z.string(), z.number()]).optional().nullable(),
  name: z.string().trim().min(1).max(300),
  matchName: z.string().max(260).optional().nullable(),
  homeTeam: z.string().max(120).optional().nullable(),
  awayTeam: z.string().max(120).optional().nullable(),
  leagueName: z.string().max(120).optional().nullable(),
  kickoff: z.string().max(40).optional().nullable(),
  odd: z.coerce.number().min(1.01).max(1000),
  probability: z.coerce.number().min(0).max(100).optional().nullable(),
  reliability: z.coerce.number().min(0).max(100).optional().nullable(),
  line: z.coerce.number().optional().nullable(),
  side: z.string().max(20).optional().nullable(),
  scope: z.string().max(20).optional().nullable(),
  bookmaker: z.string().max(60).optional().nullable(),
  family: z.enum(['ganador', 'handicap', 'total', 'total_equipo', 'corners', 'tarjetas', 'ambos_marcan', 'jugador', 'otros']).optional(),
  teamSide: z.enum(['home', 'away']).optional().nullable(),
});

const betSchema = z.object({
  stake: z.coerce.number().positive().max(1_000_000_000),
  note: z.string().max(300).optional().nullable(),
  legs: z.array(legSchema).min(1).max(20),
});

// GET — historial, resumen y analítica. Antes de responder cierra las
// selecciones cuyo resultado ya liquidó la web.
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    await settlePendingPaperBets(pgPool, user.id).catch((error) => {
      console.error('[paper-bets:settle]', error.message);
    });
    const bets = await listPaperBets(pgPool, user.id);
    return Response.json({
      bets,
      summary: summarizeBets(bets),
      analytics: analyzeLegs(bets.flatMap((bet) => bet.legs)),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[paper-bets:GET]', error.message);
    return jsonError(error);
  }
}

// POST — abre una apuesta sin dinero con las selecciones enviadas.
export async function POST(request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const limit = await redisRateLimit('paper-bets', user.id, 60, 60);
    if (!limit.success) return Response.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
    const parsed = betSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: 'Datos de apuesta inválidos', details: parsed.error.flatten() }, { status: 400 });
    }
    const bet = await createPaperBet(pgPool, user.id, parsed.data);
    return Response.json({ success: true, bet }, { status: 201 });
  } catch (error) {
    console.error('[paper-bets:POST]', error.message);
    return jsonError(error);
  }
}
