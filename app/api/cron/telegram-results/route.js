import { z } from 'zod';
import { pgPool } from '../../../../lib/db';
import { isCronAuthorized } from '../../../../lib/internal-auth';
import { buildTelegramMatchResult } from '../../../../lib/telegram-result-notifications';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ackSchema = z.object({
  eventId: z.string().uuid(),
  claimToken: z.string().uuid(),
});

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' };

async function loadSettledCandidates(client) {
  const { rows } = await client.query(
    `SELECT d.id AS combinada_id,d.fecha,pick.match,
       mr.status,mr.goals,mr.score,mr.corners,mr.yellow_cards,mr.red_cards,
       mr.goal_scorers,mr.card_events,ma.live_stats
     FROM combinada_dia d
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(d.selections)='array' THEN d.selections ELSE '[]'::jsonb END
     ) pick(match)
     LEFT JOIN LATERAL (
       SELECT status,goals,score,corners,yellow_cards,red_cards,goal_scorers,card_events
       FROM match_results
       WHERE fixture_id=(pick.match->>'fixtureId')::bigint
       ORDER BY created_at DESC NULLS LAST LIMIT 1
     ) mr ON TRUE
     LEFT JOIN LATERAL (
       SELECT live_stats FROM match_analysis
       WHERE fixture_id=(pick.match->>'fixtureId')::bigint AND live_stats IS NOT NULL
       ORDER BY created_at DESC NULLS LAST LIMIT 1
     ) ma ON TRUE
     WHERE d.status='published' AND d.fecha>=CURRENT_DATE-14
       AND pick.match ? 'fixtureId'
     ORDER BY d.fecha,(pick.match->>'kickoff')::timestamptz`,
  );

  return rows.map(row => buildTelegramMatchResult({
    dailyPickId: row.combinada_id,
    date: row.fecha,
    match: row.match,
    result: {
      status: row.status,
      goals: row.goals,
      score: row.score,
      corners: row.corners,
      yellow_cards: row.yellow_cards,
      red_cards: row.red_cards,
      goal_scorers: row.goal_scorers,
      card_events: row.card_events,
    },
    liveStats: row.live_stats,
  })).filter(Boolean);
}

export async function GET(request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const client = await pgPool.connect();
  try {
    const candidates = await loadSettledCandidates(client);
    await client.query('BEGIN');
    await client.query(
      `UPDATE telegram_result_notifications
       SET status='pending',claim_token=NULL,claimed_at=NULL,updated_at=now()
       WHERE status='sending' AND claimed_at<now()-interval '20 minutes'`,
    );
    for (const candidate of candidates) {
      await client.query(
        `INSERT INTO telegram_result_notifications
           (combinada_id,fixture_id,status,payload,updated_at)
         VALUES ($1,$2,'pending',$3::jsonb,now())
         ON CONFLICT (combinada_id,fixture_id) DO UPDATE
         SET payload=EXCLUDED.payload,updated_at=now()
         WHERE telegram_result_notifications.status IN ('pending','failed')`,
        [candidate.combinadaId, candidate.fixtureId, JSON.stringify(candidate)],
      );
    }
    const claimed = await client.query(
      `WITH candidate AS (
         SELECT id FROM telegram_result_notifications
         WHERE status IN ('pending','failed')
         ORDER BY (payload->>'kickoff')::timestamptz NULLS LAST,created_at,id
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE telegram_result_notifications n
       SET status='sending',claim_token=gen_random_uuid(),claimed_at=now(),
           attempts=n.attempts+1,updated_at=now()
       FROM candidate c WHERE n.id=c.id
       RETURNING n.id,n.claim_token,n.payload`,
    );
    await client.query('COMMIT');
    const row = claimed.rows[0];
    return Response.json({
      ok: true,
      event: row ? {
        eventId: row.id,
        claimToken: row.claim_token,
        message: row.payload.message,
        fixtureId: row.payload.fixtureId,
      } : null,
    }, { headers: NO_STORE });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[cron/telegram-results:get]', error);
    return Response.json({ error: 'No se pudieron preparar los resultados' }, { status: 500, headers: NO_STORE });
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
  const parsed = ackSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Confirmación inválida' }, { status: 400, headers: NO_STORE });
  }
  try {
    const { rowCount } = await pgPool.query(
      `UPDATE telegram_result_notifications
       SET status='sent',sent_at=now(),claim_token=NULL,updated_at=now()
       WHERE id=$1 AND claim_token=$2 AND status='sending'`,
      [parsed.data.eventId, parsed.data.claimToken],
    );
    if (rowCount !== 1) {
      return Response.json({ error: 'La entrega ya fue confirmada o la reserva venció' }, { status: 409, headers: NO_STORE });
    }
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    console.error('[cron/telegram-results:post]', error);
    return Response.json({ error: 'No se pudo confirmar el resultado' }, { status: 500, headers: NO_STORE });
  }
}
