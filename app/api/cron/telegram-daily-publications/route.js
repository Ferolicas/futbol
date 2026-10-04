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
  odd: z.number().positive(),
  category: z.string().max(220).nullable().optional(),
  family: z.string().max(120).nullable().optional(),
  scope: z.string().max(120).nullable().optional(),
  line: z.number().nullable().optional(),
  side: z.string().max(40).nullable().optional(),
  playerId: z.union([z.string(), z.number()]).nullable().optional(),
  playerName: z.string().max(220).nullable().optional(),
}).passthrough();

const fixtureIdSchema = z.union([
  z.string().regex(/^\d{1,18}$/),
  z.number().int().positive(),
]);

const matchSchema = z.object({
  fixtureId: fixtureIdSchema,
  homeId: z.union([z.string(), z.number()]).nullable().optional(),
  awayId: z.union([z.string(), z.number()]).nullable().optional(),
  homeTeam: z.string().min(1).max(220),
  awayTeam: z.string().min(1).max(220),
  league: z.string().max(220).nullable().optional(),
  kickoff: z.string().datetime({ offset: true }),
  options: z.array(optionSchema).min(1).max(3),
}).passthrough();

const sentSchema = z.object({
  sent: z.literal(true),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fixtureId: fixtureIdSchema,
  telegramMessageId: z.number().int().positive(),
  match: matchSchema,
}).superRefine((value, context) => {
  if (String(value.fixtureId) !== String(value.match.fixtureId)) {
    context.addIssue({ code: 'custom', path: ['match', 'fixtureId'], message: 'El fixture no coincide' });
  }
});

const skippedSchema = z.object({
  sent: z.literal(false),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fixtureId: fixtureIdSchema,
  error: z.string().max(1000).optional(),
});

const publicationSchema = z.union([sentSchema, skippedSchema]);
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
    return Response.json({ error: 'Publicación diaria inválida' }, { status: 400, headers: NO_STORE });
  }
  const publication = parsed.data;
  if (!publication.sent) {
    return Response.json({ ok: true, registered: false, skipped: true }, { headers: NO_STORE });
  }
  try {
    const daily = await pgPool.query(
      `SELECT id FROM combinada_dia WHERE fecha=$1 AND status='published' LIMIT 1`,
      [publication.date],
    );
    if (!daily.rows[0]) {
      return Response.json({ error: 'No existe la publicación diaria de esa fecha' }, { status: 409, headers: NO_STORE });
    }
    const { rows } = await pgPool.query(
      `INSERT INTO telegram_daily_publications
         (combinada_id,publication_date,fixture_id,telegram_message_id,payload)
       VALUES($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT(publication_date,fixture_id) DO NOTHING
       RETURNING id,publication_date,fixture_id,telegram_message_id`,
      [daily.rows[0].id, publication.date, String(publication.fixtureId),
        publication.telegramMessageId, JSON.stringify(publication.match)],
    );
    if (rows[0]) {
      return Response.json({ ok: true, registered: true, created: true, publication: rows[0] }, { headers: NO_STORE });
    }
    const existing = await pgPool.query(
      `SELECT id,publication_date,fixture_id,telegram_message_id,
         payload=$3::jsonb AS same_payload
       FROM telegram_daily_publications WHERE publication_date=$1 AND fixture_id=$2`,
      [publication.date, String(publication.fixtureId), JSON.stringify(publication.match)],
    );
    const stored = existing.rows[0];
    if (!stored
        || Number(stored.telegram_message_id) !== publication.telegramMessageId
        || stored.same_payload !== true) {
      return Response.json({
        error: 'Ese partido ya fue registrado con otro contenido de Telegram',
      }, { status: 409, headers: NO_STORE });
    }
    const { same_payload: _samePayload, ...metadata } = stored;
    return Response.json({ ok: true, registered: true, created: false, publication: metadata }, { headers: NO_STORE });
  } catch (error) {
    console.error('[telegram-daily-publications]', error);
    return Response.json({ error: 'No se pudo registrar el envío diario de Telegram' }, { status: 500, headers: NO_STORE });
  }
}
