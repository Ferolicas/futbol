import { z } from 'zod';
import { pgPool } from '../../../../lib/db';
import { isCronAuthorized } from '../../../../lib/internal-auth';
import { buildTelegramPremiumMatchResults } from '../../../../lib/telegram-premium-results';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ackSchema = z.object({
  eventId: z.string().uuid(),
  claimToken: z.string().uuid(),
});

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' };

async function loadCandidates(client) {
  const { rows } = await client.query(
    `SELECT p.id AS publication_id,p.sport,p.publication_date,p.payload,
       CASE WHEN p.sport='football' THEN jsonb_build_object(
         'status',fr.status,'goals',fr.goals,'score',fr.score,'corners',fr.corners,
         'yellow_cards',fr.yellow_cards,'red_cards',fr.red_cards,
         'goal_scorers',fr.goal_scorers,'card_events',fr.card_events
       ) ELSE jsonb_build_object(
         'status',br.status,'inning',br.inning,'inning_half',br.inning_half,
         'home_score',br.home_score,'away_score',br.away_score,
         'home_hits',br.home_hits,'away_hits',br.away_hits,
         'home_errors',br.home_errors,'away_errors',br.away_errors,
         'innings',br.innings,'home_stats',br.home_stats,'away_stats',br.away_stats
       ) END AS result,
       CASE WHEN p.sport='football' THEN jsonb_build_object('live_stats',fa.live_stats)
         ELSE jsonb_build_object('player_stats',bp.player_stats) END AS live_stats
     FROM telegram_premium_publications p
     LEFT JOIN LATERAL (
       SELECT status,goals,score,corners,yellow_cards,red_cards,goal_scorers,card_events
       FROM match_results WHERE p.sport='football' AND fixture_id=p.fixture_id::bigint
       ORDER BY created_at DESC NULLS LAST LIMIT 1
     ) fr ON TRUE
     LEFT JOIN LATERAL (
       SELECT live_stats FROM match_analysis
       WHERE p.sport='football' AND fixture_id=p.fixture_id::bigint AND live_stats IS NOT NULL
       ORDER BY created_at DESC NULLS LAST LIMIT 1
     ) fa ON TRUE
     LEFT JOIN LATERAL (
       SELECT status,inning,inning_half,home_score,away_score,home_hits,away_hits,
         home_errors,away_errors,innings,home_stats,away_stats
       FROM baseball_match_results WHERE p.sport='baseball' AND fixture_id=p.fixture_id::bigint
       ORDER BY finished_at DESC NULLS LAST LIMIT 1
     ) br ON TRUE
     LEFT JOIN LATERAL (
       SELECT COALESCE(jsonb_object_agg(player_id,jsonb_build_object(
         'playerName',player_name,'teamId',team_id,'stats',stats
       )),'{}'::jsonb) AS player_stats
       FROM baseball_engine_player_stats
       WHERE p.sport='baseball' AND fixture_id=p.fixture_id
     ) bp ON TRUE
     WHERE p.publication_date>=CURRENT_DATE-14
     ORDER BY p.publication_date,(p.payload->>'kickoff')::timestamptz`,
  );
  return rows.flatMap(row => buildTelegramPremiumMatchResults({
    publicationId: row.publication_id,
    sport: row.sport,
    date: row.publication_date,
    match: row.payload,
    result: row.result,
    liveStats: row.sport === 'football' ? row.live_stats?.live_stats : row.live_stats,
  }));
}
export async function GET(request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }
  const client = await pgPool.connect();
  try {
    const candidates = await loadCandidates(client);
    await client.query('BEGIN');
    await client.query(
      `UPDATE telegram_premium_result_notifications
       SET status='pending',claim_token=NULL,claimed_at=NULL,updated_at=now()
       WHERE status='sending' AND claimed_at<now()-interval '20 minutes'`,
    );
    for (const candidate of candidates) {
      await client.query(
        `INSERT INTO telegram_premium_result_notifications
           (publication_id,part,status,payload,updated_at)
         VALUES($1,$2,'pending',$3::jsonb,now())
         ON CONFLICT(publication_id,part) DO UPDATE
         SET payload=EXCLUDED.payload,updated_at=now()
         WHERE telegram_premium_result_notifications.status IN ('pending','failed')`,
        [candidate.publicationId, candidate.part, JSON.stringify(candidate)],
      );
    }
    const claimed = await client.query(
      `WITH candidate AS (
         SELECT id FROM telegram_premium_result_notifications
         WHERE status IN ('pending','failed')
         ORDER BY (payload->>'kickoff')::timestamptz NULLS LAST,
           publication_id,part,created_at,id
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE telegram_premium_result_notifications n
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
        sport: row.payload.sport,
      } : null,
    }, { headers: NO_STORE });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[cron/telegram-premium-results:get]', error);
    return Response.json({ error: 'No se pudieron preparar los resultados Premium' }, { status: 500, headers: NO_STORE });
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
      `UPDATE telegram_premium_result_notifications
       SET status='sent',sent_at=now(),claim_token=NULL,updated_at=now()
       WHERE id=$1 AND claim_token=$2 AND status='sending'`,
      [parsed.data.eventId, parsed.data.claimToken],
    );
    if (rowCount !== 1) {
      return Response.json({ error: 'La entrega ya fue confirmada o la reserva venció' }, { status: 409, headers: NO_STORE });
    }
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    console.error('[cron/telegram-premium-results:post]', error);
    return Response.json({ error: 'No se pudo confirmar el resultado Premium' }, { status: 500, headers: NO_STORE });
  }
}
