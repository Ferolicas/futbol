import { z } from 'zod';
import { pgPool } from '../../../../lib/db';
import { isCronAuthorized } from '../../../../lib/internal-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const optionSchema = z.object({
  id: z.string().min(1).max(220),
  name: z.string().min(1).max(500),
  probability: z.number().min(0).max(100),
  rawProbability: z.number().min(0).max(100),
  confidence: z.number().min(0).max(100),
  odd: z.number().positive().nullable().optional(),
  category: z.string().max(220).nullable().optional(),
  family: z.string().max(120).nullable().optional(),
  scope: z.string().max(120).nullable().optional(),
  line: z.number().nullable().optional(),
  side: z.string().max(40).nullable().optional(),
  playerId: z.union([z.string(), z.number()]).nullable().optional(),
  playerName: z.string().max(220).nullable().optional(),
}).passthrough();

const matchSchema = z.object({
  fixtureId: z.union([z.string().min(1).max(220), z.number()]),
  homeTeam: z.string().min(1).max(220),
  awayTeam: z.string().min(1).max(220),
  league: z.string().max(220).nullable().optional(),
  kickoff: z.string().datetime({ offset: true }),
  groups: z.record(z.string(), z.array(optionSchema)),
}).passthrough();

const sentPublicationSchema = z.object({
  sent: z.literal(true),
  sport: z.enum(['football', 'baseball']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fixtureId: z.union([z.string().min(1).max(220), z.number()]),
  telegramMessageId: z.number().int().positive(),
  match: matchSchema,
}).superRefine((value, context) => {
  if (String(value.fixtureId) !== String(value.match.fixtureId)) {
    context.addIssue({ code: 'custom', path: ['match', 'fixtureId'], message: 'El fixture no coincide' });
  }
  const optionCount = Object.values(value.match.groups).reduce((total, options) => total + options.length, 0);
  if (!optionCount) context.addIssue({ code: 'custom', path: ['match', 'groups'], message: 'No hay opciones publicadas' });
});

const skippedPublicationSchema = z.object({
  sent: z.literal(false),
  sport: z.enum(['football', 'baseball']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fixtureId: z.union([z.string().min(1).max(220), z.number()]),
  error: z.string().max(1000).optional(),
});

const publicationSchema = z.union([sentPublicationSchema, skippedPublicationSchema]);

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' };

export async function POST(request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'JSON inválido' }, { status: 400, headers: NO_STORE });
  }
  const parsed = publicationSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Publicación inválida' }, { status: 400, headers: NO_STORE });
  }
  const publication = parsed.data;
  if (!publication.sent) {
    return Response.json({ ok: true, registered: false, skipped: true }, { headers: NO_STORE });
  }
  try {
    const { rows } = await pgPool.query(
      `INSERT INTO telegram_premium_publications
         (sport,publication_date,fixture_id,telegram_message_id,payload)
       VALUES($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT(sport,publication_date,fixture_id) DO NOTHING
       RETURNING id,sport,publication_date,fixture_id,telegram_message_id`,
      [publication.sport, publication.date, String(publication.fixtureId),
        publication.telegramMessageId, JSON.stringify(publication.match)],
    );
    if (rows[0]) return Response.json({ ok: true, registered: true, created: true, publication: rows[0] }, { headers: NO_STORE });
    const existing = await pgPool.query(
      `SELECT id,sport,publication_date,fixture_id,telegram_message_id
       FROM telegram_premium_publications
       WHERE sport=$1 AND publication_date=$2 AND fixture_id=$3`,
      [publication.sport, publication.date, String(publication.fixtureId)],
    );
    return Response.json({ ok: true, registered: true, created: false, publication: existing.rows[0] }, { headers: NO_STORE });
  } catch (error) {
    console.error('[telegram-premium-publications]', error);
    return Response.json({ error: 'No se pudo registrar la publicación Premium' }, { status: 500, headers: NO_STORE });
  }
}
