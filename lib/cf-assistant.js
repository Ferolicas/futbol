import { pgPool } from './db.js';
import { freeAnalysis } from './free-access.js';

const SPORT_TABLES = {
  football: 'match_analysis',
  baseball: 'baseball_match_analysis',
  basketball: 'basketball_match_analysis',
  'american-football': 'american_football_match_analysis',
};

export async function searchExistingMatches({ query = '', date = null, limit = 12 }, pool = pgPool) {
  const text = String(query).trim().slice(0, 100);
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 12));
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT 'football' AS sport,fixture_id::text AS fixture_id,date::text AS date,
         COALESCE(analysis->>'kickoff',date::text) AS kickoff,
         COALESCE(analysis->>'league','Fútbol') AS league,
         COALESCE(analysis->>'homeTeam','Local') AS home_team,COALESCE(analysis->>'awayTeam','Visitante') AS away_team,
         COALESCE(analysis->'status'->>'short','') AS status
       FROM match_analysis
       UNION ALL SELECT 'baseball',fixture_id::text,date::text,start_time::text,league_name,home_team,away_team,status FROM baseball_match_analysis
       UNION ALL SELECT 'basketball',fixture_id::text,date::text,start_time::text,league_name,home_team,away_team,status FROM basketball_match_analysis
       UNION ALL SELECT 'american-football',fixture_id::text,date::text,start_time::text,league_name,home_team,away_team,status FROM american_football_match_analysis
     ) catalog
     WHERE ($1::text='' OR concat_ws(' ',league,home_team,away_team,fixture_id) ILIKE '%'||$1||'%')
       AND ($2::date IS NULL OR date::date=$2::date)
     ORDER BY kickoff DESC LIMIT $3`,
    [text, date || null, safeLimit],
  );
  return rows;
}
export async function getExistingPrediction({ sport, fixtureId, paidAccess }, pool = pgPool) {
  const normalizedSport = String(sport || '').toLowerCase();
  if (!SPORT_TABLES[normalizedSport] || !/^[\w:-]{1,64}$/.test(String(fixtureId || ''))) return { error: 'Identificador o deporte inválido' };
  const { rows } = await pool.query(
    `SELECT r.sport,r.fixture_id,r.kickoff,r.predicted_at,r.model_version,o.market_key,o.output,
       p.status AS seal_status,p.public_id,b.tsa_time
     FROM prediction_runs r JOIN prediction_market_outputs o ON o.run_id=r.id AND o.is_recommendation=TRUE
     LEFT JOIN prediction_seal_proofs p ON p.market_output_id=o.id
     LEFT JOIN prediction_seal_batches b ON b.id=p.batch_id
     WHERE r.sport=$1 AND r.fixture_id=$2
     ORDER BY r.predicted_at DESC,o.market_key LIMIT 80`,
    [normalizedSport, String(fixtureId)],
  );
  if (!rows.length) return { exists: false, message: 'No existe un pronóstico guardado para ese partido.' };
  const latest = rows[0].predicted_at;
  const recommendations = rows.filter((row) => String(row.predicted_at) === String(latest)).map((row) => ({
    ...row.output,
    ...(row.seal_status === 'sealed' ? { seal: { status: 'sealed', publicId: row.public_id, sealedAt: row.tsa_time } } : {}),
  }));
  if (!paidAccess) {
    const preview = freeAnalysis({ combinada: { selectable: recommendations } }, normalizedSport)?.freePreview || null;
    return { exists: true, sport: normalizedSport, fixtureId: String(fixtureId), kickoff: rows[0].kickoff, access: 'free', freePreview: preview };
  }
  return { exists: true, sport: normalizedSport, fixtureId: String(fixtureId), kickoff: rows[0].kickoff,
    predictedAt: latest, modelVersion: rows[0].model_version, recommendations };
}

export const CF_ASSISTANT_TOOLS = [{
  type: 'function', function: {
    name: 'search_existing_matches',
    description: 'Busca partidos que ya existen en CF Análisis por equipo, liga, ID o fecha. Solo lectura.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string', description: 'Equipo, liga o ID a buscar' },
      date: { type: ['string', 'null'], description: 'Fecha opcional YYYY-MM-DD' },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    }, required: ['query'] },
  },
}, {
  type: 'function', function: {
    name: 'get_existing_prediction',
    description: 'Obtiene el pronóstico ya guardado de un partido. Nunca calcula, modifica ni crea pronósticos.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      sport: { type: 'string', enum: Object.keys(SPORT_TABLES) },
      fixtureId: { type: 'string' },
    }, required: ['sport', 'fixtureId'] },
  },
}];

export async function executeAssistantTool(name, args, context) {
  if (name === 'search_existing_matches') return searchExistingMatches(args);
  if (name === 'get_existing_prediction') return getExistingPrediction({ ...args, paidAccess: context.paidAccess });
  return { error: 'Herramienta no permitida' };
}
