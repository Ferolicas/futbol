import { pgPool } from './db.js';
import { settleMarketSelection } from './market-settlement.js';
import { marketLabel } from './market-labels.js';

// Fecha desde la que /rendimiento reporta desempeño — se actualiza cada vez
// que el CÁLCULO del motor cambia de fondo (no cada deploy cosmético).
// 2026-09-22: se corrigieron dos bugs de escala que rompían toda inserción y
// calibración de béisbol/NBA/NFL desde el 2026-09-08, y se eliminó por
// decisión de producto la calibración general entre equipos + los filtros
// económicos como bloqueantes (recommendationDecision, model-to-scored.js,
// model-probabilities.js, multisport-analysis.js) — la probabilidad publicada
// pasó a ser 100% la del enfrentamiento específico, sin mezcla. Todo lo
// anterior a esta fecha quedó calculado bajo una lógica distinta y no debe
// mezclarse con el histórico nuevo. Actualizar este valor la próxima vez que
// el cálculo (no solo la infraestructura) vuelva a cambiar de fondo.
export const ENGINE_VERSION_SINCE = '2026-09-22';

export function databaseSportKey(value) {
  return String(value || '').replaceAll('-', '_');
}

export function publicSportKey(value) {
  return String(value || '').replaceAll('_', '-');
}

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
    goals: row.goals || null,
    score: row.score || null,
  };
  return settleMarketSelection({ sport: 'football', selection, game, liveResult }).status;
}

async function loadLegacyRows({ from, to, sport }, ledgerStart, pool) {
  if (!ledgerStart || (sport && sport !== 'football')) return [];
  const { rows } = await pool.query(
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
       AND (pick.selection->>'kickoff')::timestamptz<now()
       AND ($2::date IS NULL OR (pick.selection->>'kickoff')::timestamptz >= $2::date)
       AND ($3::date IS NULL OR (pick.selection->>'kickoff')::timestamptz < ($3::date + interval '1 day'))`,
    [ledgerStart, from, to],
  );
  return rows.map((row) => {
    const selection = row.selection || {};
    return {
      sport: 'football', kickoff: selection.kickoff, league: selection.league || 'Sin liga',
      homeTeam: selection.homeTeam || 'Local', awayTeam: selection.awayTeam || 'Visitante',
      marketName: selection.name || selection.category || 'Recomendación histórica',
      probability: Number(selection.rawProbability ?? selection.probability ?? 0),
      odd: Number(selection.odd || 0), outcome: legacyOutcome(row), certified: false,
    };
  });
}

function multisportLegacyOutcome(sport, row) {
  const actual = row.actual || {};
  const home = Number(row.home_score ?? actual.home);
  const away = Number(row.away_score ?? actual.away);
  const homePeriods = row.periods?.home || actual.periods?.home || [];
  const awayPeriods = row.periods?.away || actual.periods?.away || [];
  const game = {
    status: { short: 'FT' },
    scores: {
      home: { total: Number.isFinite(home) ? home : null },
      away: { total: Number.isFinite(away) ? away : null },
    },
    periods: { home: homePeriods, away: awayPeriods },
  };
  const liveResult = sport === 'baseball' ? {
    status: 'FT',
    home_score: Number.isFinite(home) ? home : null,
    away_score: Number.isFinite(away) ? away : null,
    innings: Array.from({ length: Math.max(homePeriods.length, awayPeriods.length) }, (_, index) => ({
      number: index + 1,
      home: homePeriods[index] ?? null,
      away: awayPeriods[index] ?? null,
    })),
    ...(actual.stats && typeof actual.stats === 'object' && !Array.isArray(actual.stats) ? actual.stats : {}),
  } : null;
  return settleMarketSelection({ sport, selection: row.selection, game, liveResult }).status;
}

export async function loadLegacyMultisportRows({ from, to, sport } = {}, ledgerStart, pool = pgPool) {
  if (!ledgerStart) return [];
  const requested = databaseSportKey(sport);
  const definitions = [
    { sport: 'baseball', analysis: 'baseball_match_analysis', predictions: 'baseball_engine_predictions', matches: 'baseball_engine_matches' },
    { sport: 'basketball', analysis: 'basketball_match_analysis', predictions: 'basketball_engine_predictions', matches: 'basketball_engine_matches' },
    { sport: 'american_football', analysis: 'american_football_match_analysis', predictions: 'american_football_engine_predictions', matches: 'american_football_engine_matches' },
  ].filter((definition) => !requested || requested === definition.sport);
  const batches = await Promise.all(definitions.map(async (definition) => {
    const fixtureJoin = definition.sport === 'baseball' ? 'a.fixture_id::text' : 'a.fixture_id';
    const { rows } = await pool.query(
      `SELECT a.fixture_id::text AS fixture_id,a.start_time,a.league_name,a.home_team,a.away_team,
         pick.selection,p.actual,m.home_score,m.away_score,m.periods
       FROM ${definition.analysis} a
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a.combinada->'selectable','[]'::jsonb)) pick(selection)
       JOIN ${definition.predictions} p ON p.fixture_id=${fixtureJoin} AND p.actual IS NOT NULL
       JOIN ${definition.matches} m ON m.fixture_id=${fixtureJoin}
         AND m.finalized_at IS NOT NULL AND upper(COALESCE(m.status,'')) IN ('FT','AOT','FINAL')
       WHERE a.start_time<$1 AND a.start_time<now() AND a.created_at<a.start_time
         AND ($2::date IS NULL OR a.start_time >= $2::date)
         AND ($3::date IS NULL OR a.start_time < ($3::date + interval '1 day'))
         AND regexp_replace(lower(COALESCE(pick.selection->>'bookmaker','')),'[^a-z0-9]','','g')='bet365'
         AND COALESCE((pick.selection->>'odd')::numeric,0)>=1.20
         AND COALESCE((pick.selection->>'statisticalRecommendation')::boolean,FALSE)=TRUE`,
      [ledgerStart, from || null, to || null],
    );
    return rows.map((row) => {
      const selection = row.selection || {};
      return {
        sport: publicSportKey(definition.sport), fixtureId: row.fixture_id, kickoff: row.start_time,
        league: row.league_name || 'Sin liga', homeTeam: row.home_team || 'Local', awayTeam: row.away_team || 'Visitante',
        marketName: selection.name || selection.pick || selection.category || selection.id || 'Recomendación histórica',
        probability: Number(selection.rawProbability ?? selection.probability ?? 0), odd: Number(selection.odd || 0),
        outcome: multisportLegacyOutcome(definition.sport, row), certified: false,
      };
    });
  }));
  return batches.flat();
}

async function loadLedgerRows({ from, to, sport }, pool) {
  const dbSport = sport ? databaseSportKey(sport) : null;
  const { rows } = await pool.query(
    `WITH latest_outputs AS (
       SELECT DISTINCT ON (r.sport,r.fixture_id,o.market_key)
         r.id AS run_id,r.sport,r.fixture_id,r.kickoff,r.predicted_at,r.metadata,
         o.id AS market_output_id,o.market_key,o.market_family,o.output
       FROM prediction_runs r
       -- o.is_recommendation ya distingue Recomendación estadística (TRUE) de
       -- Dato estadístico (FALSE) para baseball/basketball/american_football.
       -- En fútbol arrastraba un bug (is_recommendation quedaba TRUE con solo
       -- aparecer en el acordeón ≥70%, incluyendo el Dato estadístico 70–79%)
       -- — corregido en recordPredictionRun (prediction-ledger.js), pero las
       -- filas ya escritas conservan el valor viejo. probability_calibrated
       -- >=0.80 es la MISMA regla que decide esa etiqueta en el motor de
       -- fútbol (ver REC_MIN_PROB en model-to-scored.js) y corrige también el
       -- histórico ya persistido sin reprocesar nada.
       JOIN prediction_market_outputs o ON o.run_id=r.id AND o.is_recommendation=TRUE
         AND (r.sport<>'football' OR o.probability_calibrated>=0.80)
       WHERE r.kickoff<now()
         AND ($1::date IS NULL OR r.kickoff >= $1::date)
         AND ($2::date IS NULL OR r.kickoff < ($2::date + interval '1 day'))
         AND ($3::text IS NULL OR r.sport=$3)
       ORDER BY r.sport,r.fixture_id,o.market_key,r.predicted_at DESC
     )
     SELECT r.sport,r.kickoff,r.output,r.market_key,s.outcome,
       COALESCE(r.metadata->>'league',fm.analysis->>'league',bm.league_name,bam.league_name,afm.league_name,'Sin liga') AS league,
       COALESCE(r.metadata->>'homeTeam',fm.analysis->>'homeTeam',bm.home_team,bam.home_team,afm.home_team,'Local') AS home_team,
       COALESCE(r.metadata->>'awayTeam',fm.analysis->>'awayTeam',bm.away_team,bam.away_team,afm.away_team,'Visitante') AS away_team,
       CASE WHEN p.status='sealed' AND b.status='sealed' AND b.tsa_time<r.kickoff THEN p.public_id END AS public_id,
       CASE WHEN p.status='sealed' AND b.status='sealed' AND b.tsa_time<r.kickoff THEN b.tsa_time END AS sealed_at,
       CASE WHEN p.status='sealed' AND b.status='sealed' AND b.tsa_time<r.kickoff THEN b.provider END AS provider
     FROM latest_outputs r
     JOIN LATERAL (
       SELECT outcome FROM prediction_settlements ps
       WHERE ps.run_id=r.run_id AND ps.market_key=r.market_key
         AND ps.outcome IN ('won','lost','push','void')
       ORDER BY settled_at DESC LIMIT 1
     ) s ON TRUE
     LEFT JOIN prediction_seal_proofs p ON p.market_output_id=r.market_output_id
     LEFT JOIN prediction_seal_batches b ON b.id=p.batch_id
     LEFT JOIN LATERAL (
       SELECT analysis FROM match_analysis WHERE r.sport='football' AND fixture_id::text=r.fixture_id
       ORDER BY created_at DESC NULLS LAST LIMIT 1
     ) fm ON TRUE
     LEFT JOIN LATERAL (
       SELECT league_name,home_team,away_team FROM baseball_match_analysis
       WHERE r.sport='baseball' AND fixture_id::text=r.fixture_id ORDER BY updated_at DESC NULLS LAST LIMIT 1
     ) bm ON TRUE
     LEFT JOIN LATERAL (
       SELECT league_name,home_team,away_team FROM basketball_match_analysis
       WHERE r.sport='basketball' AND fixture_id::text=r.fixture_id ORDER BY updated_at DESC NULLS LAST LIMIT 1
     ) bam ON TRUE
     LEFT JOIN LATERAL (
       SELECT league_name,home_team,away_team FROM american_football_match_analysis
       WHERE r.sport='american_football' AND fixture_id::text=r.fixture_id ORDER BY updated_at DESC NULLS LAST LIMIT 1
     ) afm ON TRUE
     ORDER BY r.kickoff,r.sport,r.fixture_id,r.market_key`,
    [from, to, dbSport],
  );
  return rows.map((row) => ({
    sport: publicSportKey(row.sport), kickoff: row.kickoff, league: row.league,
    homeTeam: row.home_team, awayTeam: row.away_team,
    // row.output.name faltaba en fútbol para las filas escritas antes de la
    // corrección de prediction-ledger.js (guardaban _scored crudo, sin
    // nombre). marketLabel() recalcula el nombre en español desde la MISMA
    // clave interna sin tocar ni reprocesar la fila ya persistida.
    marketName: row.output?.name || row.output?.pick
      || (row.sport === 'football' ? marketLabel(row.market_key, { home: row.home_team, away: row.away_team }) : row.market_key),
    probability: Number(row.output?.rawProbability ?? row.output?.probability ?? 0),
    odd: Number(row.output?.odd || 0), outcome: row.outcome,
    certified: !!row.public_id,
    ...(row.public_id ? { seal: { status: 'sealed', publicId: row.public_id, provider: row.provider, sealedAt: row.sealed_at } } : {}),
  }));
}

function totalsFor(rows) {
  const won = rows.filter((row) => row.outcome === 'won').length;
  const lost = rows.filter((row) => row.outcome === 'lost').length;
  const neutral = rows.length - won - lost;
  return {
    won, lost, neutral, total: rows.length,
    accuracy: won + lost ? Math.round((won / (won + lost)) * 10_000) / 100 : 0,
  };
}

// El nombre de mercado tal como se muestra ya incluye equipo y/o mitad/periodo
// (p.ej. "St. Louis Cardinals: más de 4.5 carreras" o "Ajax · 1ª Parte —
// Córners a favor — Más de 4.5"): eso es la LÍNEA de apuesta concreta, no el
// mercado. El mercado es la línea sin el equipo (p.ej. "más de 4.5 carreras",
// "1ª Parte — Córners a favor — Más de 4.5"), agrupable entre partidos.
// No inventa una taxonomía nueva: sólo quita del texto ya calculado los
// nombres de equipo (homeTeam/awayTeam) que cada fila ya trae.
function stripSegmentArtifacts(segment) {
  return segment
    .replace(/^[\s:·\-–—,]+/, '')
    .replace(/[\s:·\-–—,]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function canonicalMarketName(marketName, homeTeam, awayTeam) {
  const raw = String(marketName || '').trim();
  if (!raw) return raw;
  const teamNames = [homeTeam, awayTeam]
    .map((team) => String(team || '').trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!teamNames.length) return raw;
  const stripTeams = (text) => teamNames.reduce((acc, team) => acc.split(team).join(' '), text);
  const segments = raw.split(' — ').map((segment) => stripSegmentArtifacts(stripTeams(segment))).filter(Boolean);
  const result = segments.length ? segments.join(' — ') : stripSegmentArtifacts(stripTeams(raw));
  return result || raw;
}

export function buildMarketPerformance(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!['won', 'lost', 'push', 'void'].includes(row.outcome)) continue;
    const rawMarketName = String(row.marketName || row.output?.name || row.output?.pick || row.market_key || 'Mercado sin nombre').trim();
    const marketName = canonicalMarketName(rawMarketName, row.homeTeam, row.awayTeam);
    const sport = String(row.sport || 'football');
    const key = `${sport}:${marketName.toLocaleLowerCase('es')}`;
    const current = groups.get(key) || { sport, marketName, won: 0, lost: 0, neutral: 0, total: 0 };
    current.total++;
    if (row.outcome === 'won') current.won++;
    else if (row.outcome === 'lost') current.lost++;
    else current.neutral++;
    groups.set(key, current);
  }
  return [...groups.values()].map((market) => {
    const decisive = market.won + market.lost;
    return {
      ...market,
      decisive,
      accuracy: decisive ? Math.round((market.won / decisive) * 10_000) / 100 : 0,
      tendency: market.won > market.lost ? 'winning' : market.lost > market.won ? 'losing' : 'even',
    };
  }).sort((left, right) => right.accuracy - left.accuracy
    || right.decisive - left.decisive
    || left.marketName.localeCompare(right.marketName, 'es'));
}

export function summarizePublicPerformance(rows, { page = 1, pageSize = 12, outcome = null } = {}) {
  const finalized = rows.filter((row) => ['won', 'lost', 'push', 'void'].includes(row.outcome))
    .sort((left, right) => new Date(left.kickoff) - new Date(right.kickoff));
  const certified = finalized.filter((row) => row.certified && row.seal?.publicId);
  const archive = finalized.filter((row) => !row.certified);
  let won = 0;
  let lost = 0;
  const byDay = new Map();
  for (const row of finalized) {
    if (row.outcome === 'won') won++;
    if (row.outcome === 'lost') lost++;
    const date = new Date(row.kickoff);
    byDay.set(date.toISOString().slice(0, 10), {
      date: date.toISOString().slice(0, 10),
      label: date.toLocaleDateString('es-ES', { month: 'short', year: '2-digit' }),
      won, lost, accuracy: won + lost ? Math.round((won / (won + lost)) * 10_000) / 100 : 0,
    });
  }
  // Recomendaciones individuales: TODAS las finalizadas (archivo + selladas),
  // no solo las que tienen sello FreeTSA — cada una marca si está sellada o
  // no (el frontend nunca presenta el archivo como si tuviera prueba externa).
  const individualPool = outcome ? finalized.filter((row) => row.outcome === outcome) : finalized;
  const orderedIndividual = individualPool.slice().reverse();
  const totalPages = Math.max(1, Math.ceil(orderedIndividual.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const offset = (safePage - 1) * pageSize;
  return {
    totals: totalsFor(finalized),
    periods: {
      archive: { ...totalsFor(archive), label: 'Histórico anterior o sin sello externo', retroactivelySealed: false },
      certified: { ...totalsFor(certified), label: 'Recomendaciones con sello FreeTSA', retroactivelySealed: false },
    },
    marketPerformance: buildMarketPerformance(finalized),
    coverage: {
      since: finalized[0]?.kickoff || null,
      through: finalized.at(-1)?.kickoff || null,
      certifiedSince: certified[0]?.kickoff || null,
      certifiedRecommendations: certified.length,
    },
    curve: [{ date: null, label: 'Inicio', won: 0, lost: 0, accuracy: 0 }, ...byDay.values()],
    recommendations: orderedIndividual.slice(offset, offset + pageSize).map((row) => ({
      sport: row.sport, kickoff: row.kickoff, league: row.league,
      matchName: `${row.homeTeam} vs ${row.awayTeam}`, marketName: row.marketName,
      probability: row.probability, odd: row.odd, outcome: row.outcome,
      certified: !!(row.certified && row.seal?.publicId), seal: row.seal || null,
    })),
    pagination: { page: safePage, pageSize, totalItems: individualPool.length, totalPages },
  };
}

export async function getPublicPerformance(filters, pool = pgPool) {
  // Todos los tiempos ("all" y cualquier rango) quedan acotados a la versión
  // vigente del motor: nunca se reporta desempeño de una versión retirada.
  const boundedFrom = filters.from && filters.from > ENGINE_VERSION_SINCE ? filters.from : ENGINE_VERSION_SINCE;
  const boundedFilters = { ...filters, from: boundedFrom };
  const { rows: startRows } = await pool.query(`SELECT min(kickoff) AS kickoff FROM prediction_runs`);
  const [legacy, ledger] = await Promise.all([
    loadLegacyRows(boundedFilters, startRows[0]?.kickoff || null, pool),
    loadLedgerRows(boundedFilters, pool),
  ]);
  const legacyMultisport = await loadLegacyMultisportRows(boundedFilters, startRows[0]?.kickoff || null, pool);
  const query = String(boundedFilters.query || '').trim().toLocaleLowerCase('es');
  const rows = [...legacy, ...legacyMultisport, ...ledger];
  const contains = (value, wanted) => String(value || '').toLocaleLowerCase('es').includes(String(wanted || '').trim().toLocaleLowerCase('es'));
  const allRows = rows
    .filter((row) => !boundedFilters.league || contains(row.league, boundedFilters.league))
    .filter((row) => !boundedFilters.market || contains(row.marketName, boundedFilters.market))
    .filter((row) => !boundedFilters.team || contains(`${row.homeTeam} ${row.awayTeam}`, boundedFilters.team))
    .filter((row) => !query || [row.league, row.homeTeam, row.awayTeam, row.marketName].some((value) => contains(value, query)));
  return {
    ...summarizePublicPerformance(allRows, boundedFilters),
    engineSince: ENGINE_VERSION_SINCE,
    options: {
      leagues: [...new Set(rows.map((row) => row.league).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')),
      markets: [...new Set(rows.map((row) => row.marketName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')),
      teams: [...new Set(rows.flatMap((row) => [row.homeTeam, row.awayTeam]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')),
    },
  };
}
