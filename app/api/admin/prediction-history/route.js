import { z } from 'zod';
import { pgPool } from '../../../../lib/db';
import { getUserProfile } from '../../../../lib/supabase-auth';
import { jsonError } from '../../../../lib/api-error';
import { settleMarketSelection } from '../../../../lib/market-settlement';

export const dynamic = 'force-dynamic';

const schema = z.object({
  preset: z.enum(['all','day','week','fortnight','month','quarter','semester','year','custom']).default('all'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  league: z.string().max(120).optional(),
  market: z.string().max(160).optional(),
  team: z.string().max(120).optional(),
});

const presetDays = { day: 1, week: 7, fortnight: 15, month: 30, quarter: 90, semester: 182, year: 365 };

function legacyOutcome(row) {
  const selection = row.selection || {};
  const liveResult = row.result_status ? {
    status: row.result_status,
    goals: row.goals,
    score: row.score,
    corners: row.corners ? { ...row.corners, isReal: row.corners.isReal !== false } : null,
    yellowCards: row.yellow_cards ? { ...row.yellow_cards, isReal: row.yellow_cards.isReal !== false } : null,
    redCards: row.red_cards ? { ...row.red_cards, isReal: row.red_cards.isReal !== false } : null,
    goalScorers: row.goal_scorers || [],
    cardEvents: row.card_events || [],
    realFinal: true,
  } : null;
  const game = {
    fixture: { id: Number(selection.fixtureId), date: selection.kickoff, status: { short: row.result_status || 'NS' } },
    teams: { home: { name: selection.homeTeam || 'Local' }, away: { name: selection.awayTeam || 'Visitante' } },
    goals: row.goals || null, score: row.score || null,
  };
  return settleMarketSelection({ sport: 'football', selection, game, liveResult }).status;
}

async function legacyPublishedRows({ from, to, league, market, team }, before) {
  if (!before) return [];
  const { rows } = await pgPool.query(
    `SELECT pick.selection,mr.status AS result_status,mr.goals,mr.score,mr.corners,mr.yellow_cards,
       mr.red_cards,mr.goal_scorers,mr.card_events
     FROM combinada_dia day
     CROSS JOIN LATERAL jsonb_array_elements(day.selections) pick(selection)
     LEFT JOIN LATERAL (
       SELECT status,goals,score,corners,yellow_cards,red_cards,goal_scorers,card_events
       FROM match_results WHERE fixture_id=(pick.selection->>'fixtureId')::bigint
       ORDER BY created_at DESC NULLS LAST LIMIT 1
     ) mr ON TRUE
     WHERE (pick.selection->>'kickoff')::timestamptz<$1
       AND ($2::date IS NULL OR (pick.selection->>'kickoff')::timestamptz >= $2::date)
       AND ($3::date IS NULL OR (pick.selection->>'kickoff')::timestamptz < ($3::date + interval '1 day'))
       AND ($4::text IS NULL OR pick.selection->>'league' ILIKE '%'||$4||'%')
       AND ($5::text IS NULL OR concat_ws(' ',pick.selection->>'category',pick.selection->>'id',pick.selection->>'name') ILIKE '%'||$5||'%')
       AND ($6::text IS NULL OR pick.selection->>'homeTeam' ILIKE '%'||$6||'%' OR pick.selection->>'awayTeam' ILIKE '%'||$6||'%')`,
    [before, from, to, league || null, market || null, team || null],
  );
  return rows.map((row) => {
    const selection = row.selection || {};
    return {
      sport: 'football', fixture_id: String(selection.fixtureId), kickoff: selection.kickoff,
      market_key: String(selection.id || selection.category || 'legacy'), market_family: selection.category || null,
      output: selection, outcome: legacyOutcome(row), league: selection.league || 'Sin liga',
      home_team: selection.homeTeam || 'Local', away_team: selection.awayTeam || 'Visitante',
    };
  });
}

export async function GET(request) {
  const profile = await getUserProfile();
  if (!profile || !['admin', 'owner'].includes(profile.role)) return Response.json({ error: 'Forbidden' }, { status: 403 });
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: 'Filtros inválidos' }, { status: 400 });
  const filters = parsed.data;
  let from = filters.from || null;
  let to = filters.to || null;
  if (filters.preset !== 'custom' && filters.preset !== 'all') {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - presetDays[filters.preset] + 1);
    from = date.toISOString().slice(0, 10);
    to = new Date().toISOString().slice(0, 10);
  }
  try {
    const [{ rows: ledgerRows }, { rows: ledgerStartRows }] = await Promise.all([pgPool.query(
      `WITH latest_outputs AS (
        SELECT DISTINCT ON (r.sport,r.fixture_id,o.market_key)
          r.id AS run_id,r.sport,r.fixture_id,r.kickoff,r.predicted_at,r.metadata,
          o.market_key,o.market_family,o.output
        FROM prediction_runs r
        JOIN prediction_market_outputs o ON o.run_id=r.id AND o.is_recommendation=TRUE
        ORDER BY r.sport,r.fixture_id,o.market_key,r.predicted_at DESC
      ), history AS (
        SELECT r.sport,r.fixture_id,r.kickoff,r.market_key,r.market_family,r.output,
          s.outcome,s.settled_at,
          COALESCE(r.metadata->>'league',fm.analysis->>'league',bm.league_name,bam.league_name,afm.league_name,'Sin liga') AS league,
          COALESCE(r.metadata->>'homeTeam',fm.analysis->>'homeTeam',bm.home_team,bam.home_team,afm.home_team,'Local') AS home_team,
          COALESCE(r.metadata->>'awayTeam',fm.analysis->>'awayTeam',bm.away_team,bam.away_team,afm.away_team,'Visitante') AS away_team
        FROM latest_outputs r
        JOIN LATERAL (
          SELECT outcome,settled_at FROM prediction_settlements ps
          WHERE ps.run_id=r.run_id AND ps.market_key=r.market_key AND ps.outcome IN ('won','lost','push','void')
          ORDER BY settled_at DESC LIMIT 1
        ) s ON TRUE
        LEFT JOIN LATERAL (
          SELECT analysis FROM match_analysis
          WHERE r.sport='football' AND fixture_id::text=r.fixture_id
          ORDER BY created_at DESC NULLS LAST LIMIT 1
        ) fm ON TRUE
        LEFT JOIN LATERAL (
          SELECT league_name,home_team,away_team FROM baseball_match_analysis
          WHERE r.sport='baseball' AND fixture_id::text=r.fixture_id
          ORDER BY updated_at DESC NULLS LAST LIMIT 1
        ) bm ON TRUE
        LEFT JOIN LATERAL (
          SELECT league_name,home_team,away_team FROM basketball_match_analysis
          WHERE r.sport='basketball' AND fixture_id::text=r.fixture_id
          ORDER BY updated_at DESC NULLS LAST LIMIT 1
        ) bam ON TRUE
        LEFT JOIN LATERAL (
          SELECT league_name,home_team,away_team FROM american_football_match_analysis
          WHERE r.sport='american-football' AND fixture_id::text=r.fixture_id
          ORDER BY updated_at DESC NULLS LAST LIMIT 1
        ) afm ON TRUE
      )
      SELECT * FROM history
      WHERE ($1::date IS NULL OR kickoff >= $1::date)
        AND ($2::date IS NULL OR kickoff < ($2::date + interval '1 day'))
        AND ($3::text IS NULL OR league ILIKE '%'||$3||'%')
        AND ($4::text IS NULL OR COALESCE(market_family,market_key) ILIKE '%'||$4||'%')
        AND ($5::text IS NULL OR home_team ILIKE '%'||$5||'%' OR away_team ILIKE '%'||$5||'%')
      ORDER BY kickoff,fixture_id,market_key`,
      [from, to, filters.league || null, filters.market || null, filters.team || null],
    ), pgPool.query(`SELECT min(kickoff) AS kickoff FROM prediction_runs`)]);
    const legacyRows = await legacyPublishedRows({ ...filters, from, to }, ledgerStartRows[0]?.kickoff || null);
    const rows = [...legacyRows, ...ledgerRows].sort((left, right) =>
      new Date(left.kickoff) - new Date(right.kickoff) || String(left.fixture_id).localeCompare(String(right.fixture_id)));
    let won = 0;
    let settled = 0;
    const dailyCurve = new Map();
    for (const row of rows) {
      if (row.outcome === 'won') won++;
      if (['won', 'lost'].includes(row.outcome)) settled++;
      const date = new Date(row.kickoff);
      dailyCurve.set(date.toISOString().slice(0, 10), {
        label: date.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: '2-digit' }), won, settled,
      });
    }
    const curve = [{ label: 'Inicio', won: 0, settled: 0 }, ...dailyCurve.values()];
    const lost = rows.filter((row) => row.outcome === 'lost').length;
    const pending = rows.filter((row) => !['won', 'lost'].includes(row.outcome)).length;
    const leagues = [...new Set(rows.map((row) => row.league).filter(Boolean))].sort();
    const markets = [...new Set(rows.map((row) => row.market_family || row.market_key).filter(Boolean))].sort();
    const teams = [...new Set(rows.flatMap((row) => [row.home_team, row.away_team]).filter(Boolean))].sort();
    const groupedMatches = new Map();
    for (const row of rows.slice().reverse()) {
      const key = `${row.sport}:${row.fixture_id}`;
      const selection = { id: row.market_key, name: row.output?.name || row.output?.pick || row.market_key,
        probability: Number(row.output?.rawProbability ?? row.output?.probability ?? 0), odd: Number(row.output?.odd || 0),
        outcome: { status: row.outcome, settled: ['won', 'lost', 'push', 'void'].includes(row.outcome) } };
      if (groupedMatches.has(key)) groupedMatches.get(key).selections.push(selection);
      else groupedMatches.set(key, {
        sport: row.sport, fixtureId: row.fixture_id, kickoff: row.kickoff, league: row.league,
        matchName: `${row.home_team} vs ${row.away_team}`, selections: [selection],
      });
      if (groupedMatches.size >= 300) break;
    }
    return Response.json({
      scope: { preset: filters.preset, from, to },
      totals: { won, lost, pending, total: rows.length, accuracy: settled ? Math.round(won / settled * 10_000) / 100 : 0 },
      curve,
      matches: [...groupedMatches.values()].map((match) => ({
        ...match,
        isLive: false,
        isFinal: match.selections.every((selection) => selection.outcome.settled),
      })),
      options: { leagues, markets, teams }, updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[admin/prediction-history]', error);
    return jsonError(error);
  }
}
