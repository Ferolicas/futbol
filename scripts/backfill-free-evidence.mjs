// Add only Free evidence and display ladders; never replace paid predictions.
// node --env-file=.env.local scripts/backfill-free-evidence.mjs [--apply] [--refresh-football]
import pg from 'pg';
import football from '../lib/model-engine.js';
import { freeFootballEvidence } from '../lib/free-football-evidence.js';
import { computeMultisportEmpiricalPrediction } from '../lib/multisport-empirical-engine.js';
const apply = process.argv.includes('--apply');
const refreshFootball = process.argv.includes('--refresh-football');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 2 });
try {
  const footballRows = await pool.query(`SELECT a.fixture_id,a.analysis,m.season,m.phase FROM match_analysis a LEFT JOIN model.matches m USING(fixture_id)
    WHERE a.date >= ${refreshFootball ? 'CURRENT_DATE' : 'CURRENT_DATE-1'}
      AND ($1::boolean OR NOT (a.analysis ? '_freeScored')) ORDER BY a.date DESC`, [refreshFootball]);
  let complete = 0, available = 0;
  for (const row of footballRows.rows) {
    const a = row.analysis;
    if (!a?.homeId || !a?.awayId) continue;
    const cutoff = new Date(Math.min(Date.now(), new Date(a.kickoff || Date.now()).getTime()));
    const context = { fixtureId: row.fixture_id, homeTeamId: a.homeId, awayTeamId: a.awayId, competitionId: a.leagueId,
      season: row.season, phase: row.phase || 'regular', referee: a.referee, homeRank: a.homePosition, awayRank: a.awayPosition, nTeams: null, cutoff };
    const prediction = await football.predict(pool, context, { currentLineups: a.lineups?.available ? a.lineups.data : null });
    const evidence = freeFootballEvidence(prediction.markets);
    if (Object.keys(evidence).length) available++;
    if (apply) await pool.query("UPDATE match_analysis SET analysis=jsonb_set(analysis,'{_freeScored}',$2::jsonb) WHERE fixture_id=$1", [row.fixture_id, JSON.stringify(evidence)]);
    complete++;
    if (complete % 25 === 0) console.log(JSON.stringify({ sport: 'football', complete, available, apply }));
  }
  console.log(JSON.stringify({ sport: 'football', complete, available, apply }));
  for (const sport of ['baseball', 'basketball', 'american_football']) {
    const table = `${sport}_match_analysis`;
    const { rows } = await pool.query(`SELECT a.*,m.season,m.raw FROM ${table} a LEFT JOIN ${sport}_engine_matches m ON a.fixture_id::text=m.fixture_id WHERE a.date >= CURRENT_DATE-1`);
    let complete = 0;
    for (const row of rows) {
      const path = sport === 'baseball' ? '{evidence,displayFrequencies}' : '{displayFrequencies}';
      if (sport === 'baseball' && !row.probabilities?.evidence) continue;
      const fixture = { id: row.fixture_id, date: row.start_time, season: row.season, league: { id: row.league_id },
        teams: { home: { id: row.home_team_id, name: row.home_team }, away: { id: row.away_team_id, name: row.away_team } },
        context: row.raw?.context || {} };
      const prediction = await computeMultisportEmpiricalPrediction(pool, { sport, fixture, odds: {}, cutoff: new Date(Math.min(Date.now(), new Date(row.start_time).getTime())) });
      if (apply) await pool.query(`UPDATE ${table} SET probabilities=jsonb_set(probabilities,$2::text[],$3::jsonb) WHERE fixture_id=$1`, [row.fixture_id, path, JSON.stringify(prediction.displayFrequencies)]);
      if (apply) for (const [period, values] of Object.entries(prediction.periods || {})) {
        if (!values.displayFrequencies) continue;
        const parent = sport === 'baseball' ? ['evidence', 'periods', period] : ['periods', period];
        await pool.query(`UPDATE ${table} SET probabilities=jsonb_set(probabilities,$2::text[],$3::jsonb) WHERE fixture_id=$1 AND probabilities #> $4::text[] IS NOT NULL`,
          [row.fixture_id, [...parent, 'displayFrequencies'], JSON.stringify(values.displayFrequencies), parent]);
      }
      complete++;
    }
    console.log(JSON.stringify({ sport, displayLadders: complete, apply }));
  }
} finally { await pool.end(); }
