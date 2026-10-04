import { z } from 'zod';
import { pgPool } from '../../../../lib/db';
import { isCronAuthorized } from '../../../../lib/internal-auth';
import { buildTelegramMatchResult } from '../../../../lib/telegram-result-notifications';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const fixtureIdSchema = z.union([z.string().regex(/^\d{1,18}$/), z.number().int().positive()]);
const optionSchema = z.object({
  id: z.string().min(1).max(220),
  name: z.string().min(1).max(500),
}).passthrough();
const registerSchema = z.object({
  action: z.literal('register'),
  sent: z.literal(true),
  combinadaId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fixtureId: fixtureIdSchema,
  telegramMessageId: z.number().int().positive(),
  match: z.object({
    fixtureId: fixtureIdSchema,
    homeTeam: z.string().min(1).max(220),
    awayTeam: z.string().min(1).max(220),
    kickoff: z.string().datetime({ offset: true }),
    options: z.array(optionSchema).min(1).max(3),
  }).passthrough(),
}).superRefine((value, context) => {
  if (String(value.fixtureId) !== String(value.match.fixtureId)) {
    context.addIssue({ code: 'custom', path: ['match', 'fixtureId'], message: 'El fixture no coincide' });
  }
});
const ackSchema = z.object({
  eventId: z.string().uuid(),
  claimToken: z.string().uuid(),
});

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' };

async function storedOutcomes(client, fixtureId, marketKeys) {
  const { rows } = await client.query(
    `WITH latest_outputs AS (
       SELECT DISTINCT ON (o.market_key) r.id AS run_id,o.market_key
       FROM prediction_runs r
       JOIN prediction_market_outputs o ON o.run_id=r.id
       WHERE r.sport='football' AND r.fixture_id=$1
         AND o.market_key=ANY($2::text[])
       ORDER BY o.market_key,r.predicted_at DESC
     )
     SELECT output.market_key,settled.outcome
     FROM latest_outputs output
     JOIN LATERAL (
       SELECT ps.outcome FROM prediction_settlements ps
       WHERE ps.run_id=output.run_id AND ps.market_key=output.market_key
         AND ps.outcome IN ('won','lost')
       ORDER BY ps.settled_at DESC,ps.id DESC LIMIT 1
     ) settled ON TRUE`,
    [String(fixtureId), marketKeys],
  );
  return rows.map(row => ({ marketKey: row.market_key, outcome: row.outcome }));
}

export async function GET(request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }
  const client = await pgPool.connect();
  try {
    await client.query(
      `UPDATE telegram_result_notifications
       SET status='pending',claim_token=NULL,claimed_at=NULL,updated_at=now()
       WHERE status='sending' AND claimed_at<now()-interval '20 minutes'`,
    );
    const { rows } = await client.query(
      `SELECT n.id,n.combinada_id,n.fixture_id,n.payload,d.fecha
       FROM telegram_result_notifications n
       JOIN combinada_dia d ON d.id=n.combinada_id
       WHERE n.status IN ('pending','failed') AND n.payload ? 'match'
         AND d.fecha>=CURRENT_DATE-14
       ORDER BY (n.payload->'match'->>'kickoff')::timestamptz NULLS LAST,n.created_at,n.id`,
    );
    for (const row of rows) {
      const match = row.payload?.match;
      const marketKeys = (match?.options || []).map(option => String(option.id || '')).filter(Boolean);
      if (!marketKeys.length) continue;
      const outcomes = await storedOutcomes(client, row.fixture_id, marketKeys);
      const result = buildTelegramMatchResult({
        dailyPickId: row.combinada_id,
        date: row.fecha,
        match,
        outcomes,
      });
      if (!result) continue;
      const claim = await client.query(
        `UPDATE telegram_result_notifications
         SET status='sending',claim_token=gen_random_uuid(),claimed_at=now(),
           attempts=attempts+1,payload=payload||$2::jsonb,updated_at=now()
         WHERE id=$1 AND status IN ('pending','failed')
         RETURNING id,claim_token,payload`,
        [row.id, JSON.stringify({ result })],
      );
      if (!claim.rows[0]) continue;
      return Response.json({
        ok: true,
        event: {
          eventId: claim.rows[0].id,
          claimToken: claim.rows[0].claim_token,
          message: result.message,
          fixtureId: result.fixtureId,
        },
      }, { headers: NO_STORE });
    }
    return Response.json({ ok: true, event: null }, { headers: NO_STORE });
  } catch (error) {
    console.error('[cron/telegram-results:get]', error);
    return Response.json({ error: 'No se pudieron consultar los resultados publicados por la web' }, { status: 500, headers: NO_STORE });
  } finally {
    client.release();
  }
}

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

  const registration = registerSchema.safeParse(body);
  if (registration.success) {
    const item = registration.data;
    try {
      const published = await pgPool.query(
        `SELECT id FROM combinada_dia WHERE id=$1 AND fecha=$2 AND status='published'`,
        [item.combinadaId, item.date],
      );
      if (!published.rows[0]) {
        return Response.json({ error: 'La publicación web indicada no existe' }, { status: 409, headers: NO_STORE });
      }
      const payload = { telegramMessageId: item.telegramMessageId, match: item.match };
      const inserted = await pgPool.query(
        `INSERT INTO telegram_result_notifications
           (combinada_id,fixture_id,status,payload,updated_at)
         VALUES($1,$2,'pending',$3::jsonb,now())
         ON CONFLICT(combinada_id,fixture_id) DO NOTHING
         RETURNING id`,
        [item.combinadaId, String(item.fixtureId), JSON.stringify(payload)],
      );
      if (inserted.rows[0]) {
        return Response.json({ ok: true, registered: true, created: true }, { headers: NO_STORE });
      }
      const existing = await pgPool.query(
        `SELECT (payload-'result')=$3::jsonb AS same_payload
         FROM telegram_result_notifications WHERE combinada_id=$1 AND fixture_id=$2`,
        [item.combinadaId, String(item.fixtureId), JSON.stringify(payload)],
      );
      if (existing.rows[0]?.same_payload !== true) {
        return Response.json({ error: 'Ese envío ya fue registrado con otro contenido' }, { status: 409, headers: NO_STORE });
      }
      return Response.json({ ok: true, registered: true, created: false }, { headers: NO_STORE });
    } catch (error) {
      console.error('[cron/telegram-results:register]', error);
      return Response.json({ error: 'No se pudo registrar el envío confirmado por Telegram' }, { status: 500, headers: NO_STORE });
    }
  }

  const ack = ackSchema.safeParse(body);
  if (!ack.success) {
    return Response.json({ error: 'Solicitud inválida' }, { status: 400, headers: NO_STORE });
  }
  try {
    const { rowCount } = await pgPool.query(
      `UPDATE telegram_result_notifications
       SET status='sent',sent_at=now(),claim_token=NULL,updated_at=now()
       WHERE id=$1 AND claim_token=$2 AND status='sending'`,
      [ack.data.eventId, ack.data.claimToken],
    );
    if (rowCount !== 1) {
      return Response.json({ error: 'La entrega ya fue confirmada o la reserva venció' }, { status: 409, headers: NO_STORE });
    }
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    console.error('[cron/telegram-results:ack]', error);
    return Response.json({ error: 'No se pudo confirmar el resultado enviado' }, { status: 500, headers: NO_STORE });
  }
}
