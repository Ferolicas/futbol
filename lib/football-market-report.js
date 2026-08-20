import { pgPool } from './db.js';

const CORNER_LINES = [8.5, 9.5, 10.5];
const TEAM_CORNER_LINES = [2.5, 3.5, 4.5, 5.5, 6.5];
const HALF_TEAM_CORNER_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const GOAL_LINES = [1.5, 2.5, 3.5, 4.5];
const CARD_LINES = [1.5, 2.5, 3.5, 4.5, 5.5];

const GOAL_SCOPES = [
  { key: 'total_goals', period: 'Partido', scope: 'Total partido' },
  { key: 'home_goals', period: 'Partido', scope: 'Equipo local' },
  { key: 'away_goals', period: 'Partido', scope: 'Equipo visitante' },
  { key: 'total_goals_1h', period: '1ª parte', scope: 'Total 1ª parte' },
  { key: 'home_goals_1h', period: '1ª parte', scope: 'Local 1ª parte' },
  { key: 'away_goals_1h', period: '1ª parte', scope: 'Visitante 1ª parte' },
  { key: 'total_goals_2h', period: '2ª parte', scope: 'Total 2ª parte' },
  { key: 'home_goals_2h', period: '2ª parte', scope: 'Local 2ª parte' },
  { key: 'away_goals_2h', period: '2ª parte', scope: 'Visitante 2ª parte' },
];

const CORNER_SCOPES = [
  { key: 'total_corners', period: 'Partido', scope: 'Total partido', lines: CORNER_LINES },
  { key: 'home_corners', period: 'Partido', scope: 'Equipo local', lines: TEAM_CORNER_LINES },
  { key: 'away_corners', period: 'Partido', scope: 'Equipo visitante', lines: TEAM_CORNER_LINES },
  { key: 'home_corners_1h', period: '1ª parte', scope: 'Local 1ª parte', lines: HALF_TEAM_CORNER_LINES },
  { key: 'away_corners_1h', period: '1ª parte', scope: 'Visitante 1ª parte', lines: HALF_TEAM_CORNER_LINES },
  { key: 'home_corners_2h', period: '2ª parte', scope: 'Local 2ª parte', lines: HALF_TEAM_CORNER_LINES },
  { key: 'away_corners_2h', period: '2ª parte', scope: 'Visitante 2ª parte', lines: HALF_TEAM_CORNER_LINES },
];

const CARD_SCOPES = [
  { key: 'total_cards', period: 'Partido', scope: 'Total partido' },
  { key: 'home_cards', period: 'Partido', scope: 'Equipo local' },
  { key: 'away_cards', period: 'Partido', scope: 'Equipo visitante' },
];

const RESULT_MARKETS = [
  { key: 'home_win', group: 'Resultados', label: 'Gana el equipo local', scope: 'Equipo local' },
  { key: 'away_win', group: 'Resultados', label: 'Pierde el equipo local', scope: 'Equipo local' },
  { key: 'away_win', group: 'Resultados', label: 'Gana el equipo visitante', scope: 'Equipo visitante' },
  { key: 'home_win', group: 'Resultados', label: 'Pierde el equipo visitante', scope: 'Equipo visitante' },
  { key: 'draw', group: 'Resultados', label: 'Empate', scope: 'Total partido' },
];

const HANDICAP_MARKETS = [
  { key: 'ah_home_m0_5', label: 'Local -0.5', line: -0.5 },
  { key: 'ah_home_m1_5', label: 'Local -1.5', line: -1.5 },
  { key: 'ah_home_p0_5', label: 'Local +0.5', line: 0.5 },
  { key: 'ah_home_p1_5', label: 'Local +1.5', line: 1.5 },
  { key: 'eh_home_m1', label: 'Hándicap europeo · Local -1', line: -1 },
  { key: 'eh_home_p1', label: 'Hándicap europeo · Local +1', line: 1 },
];

const FALLBACK_SCOPES = [
  { key: 'total_corners', expression: '(corners_for + corners_against)', lines: CORNER_LINES },
  { key: 'home_corners', expression: 'corners_for', lines: TEAM_CORNER_LINES },
  { key: 'away_corners', expression: 'corners_against', lines: TEAM_CORNER_LINES },
  { key: 'total_goals', expression: 'total_goals', lines: GOAL_LINES },
  { key: 'home_goals', expression: 'goals_for', lines: GOAL_LINES },
  { key: 'away_goals', expression: 'goals_against', lines: GOAL_LINES },
  { key: 'total_goals_1h', expression: '(gf_1h + ga_1h)', lines: GOAL_LINES },
  { key: 'home_goals_1h', expression: 'gf_1h', lines: GOAL_LINES },
  { key: 'away_goals_1h', expression: 'ga_1h', lines: GOAL_LINES },
  { key: 'total_goals_2h', expression: '(gf_2h + ga_2h)', lines: GOAL_LINES },
  { key: 'home_goals_2h', expression: 'gf_2h', lines: GOAL_LINES },
  { key: 'away_goals_2h', expression: 'ga_2h', lines: GOAL_LINES },
  { key: 'total_cards', expression: '(yellow_for + COALESCE(red_for,0) + yellow_against + COALESCE(red_against,0))', lines: CARD_LINES },
  { key: 'home_cards', expression: '(yellow_for + COALESCE(red_for,0))', lines: CARD_LINES },
  { key: 'away_cards', expression: '(yellow_against + COALESCE(red_against,0))', lines: CARD_LINES },
];

function unwrapAnalysis(value) {
  if (!value || typeof value !== 'object') return {};
  if (value.analysis && typeof value.analysis === 'object') return value.analysis;
  return value;
}

function percent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number >= 0 && number <= 1 ? number * 100 : number;
}

function metric(scored, key) {
  const entry = scored?.[key];
  if (!entry || typeof entry !== 'object') return { probability: null, reliability: null, sample: null };
  return {
    probability: percent(entry.prob_final ?? entry.prob),
    reliability: percent(entry.confidence),
    sample: Number.isFinite(Number(entry.n)) ? Number(entry.n) : null,
  };
}

function marketKey(prefix, direction, line) {
  return `${prefix}_${direction}${String(line).replace('.', '_')}`;
}

function directionLabel(kind, direction, line) {
  const threshold = Math.floor(line);
  if (kind === 'Córners') {
    return direction === 'over'
      ? `≥ ${threshold + 1} córners (Más de ${line})`
      : `≤ ${threshold} córners (Menos de ${line})`;
  }
  if (kind === 'Tarjetas') {
    const count = direction === 'over' ? threshold + 1 : threshold;
    const unit = count === 1 ? 'tarjeta' : 'tarjetas';
    return direction === 'over'
      ? `≥ ${count} ${unit} (Más de ${line})`
      : `≤ ${count} ${unit} (Menos de ${line})`;
  }
  const count = direction === 'over' ? threshold + 1 : threshold;
  const unit = count === 1 ? 'gol' : 'goles';
  return direction === 'over'
    ? `≥ ${count} ${unit} (Más de ${line})`
    : `≤ ${count} ${unit} (Menos de ${line})`;
}

function formatKickoff(value) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function resolvedScope(value, analysis) {
  return String(value || '')
    .replace('Equipo local', analysis.homeTeam || 'Equipo local')
    .replace('Equipo visitante', analysis.awayTeam || 'Equipo visitante')
    .replace('Local ', `${analysis.homeTeam || 'Local'} `)
    .replace('Visitante ', `${analysis.awayTeam || 'Visitante'} `);
}

function pushOuRows(rows, { base, scored, definitions, group, direction }) {
  for (const definition of definitions) {
    for (const line of definition.lines) {
      const key = marketKey(definition.key, direction, line);
      rows.push({
        ...base,
        grupo: group,
        periodo: definition.period,
        ambito: definition.scope,
        mercado: group,
        direccion: direction,
        line_number: line,
        linea: directionLabel(group, direction, line),
        market_key: key,
        ...metric(scored, key),
      });
    }
  }
}

export function buildFootballPersonalMarketRows(analyses, date, fallbackEvidence = {}) {
  const rows = [];
  for (const stored of analyses || []) {
    const analysis = unwrapAnalysis(stored.analysis || stored);
    // La evidencia específica siempre gana. La base global solo completa un
    // mercado realmente ausente y lleva fiabilidad capada por debajo de 70%.
    const scored = {
      ...fallbackEvidence,
      ...(analysis._reportScored || analysis._scored || {}),
    };
    const base = {
      fecha: date || stored.date || analysis.date || '',
      hora_bogota: formatKickoff(analysis.kickoff),
      fixture_id: Number(stored.fixture_id ?? analysis.fixtureId) || '',
      liga: analysis.league || '',
      partido: `${analysis.homeTeam || 'Local'} vs ${analysis.awayTeam || 'Visitante'}`,
    };

    const corners = CORNER_SCOPES.map(scope => ({ ...scope, scope: resolvedScope(scope.scope, analysis) }));
    const goals = GOAL_SCOPES.map(scope => ({ ...scope, scope: resolvedScope(scope.scope, analysis), lines: GOAL_LINES }));
    const cards = CARD_SCOPES.map(scope => ({ ...scope, scope: resolvedScope(scope.scope, analysis), lines: CARD_LINES }));

    // Orden contractual para móvil/CSV: primero TODOS los “Más de”; después
    // TODOS los “Menos de”. Nunca se vuelven a intercalar por línea.
    for (const direction of ['over', 'under']) {
      pushOuRows(rows, { base, scored, definitions: corners, group: 'Córners', direction });
      pushOuRows(rows, { base, scored, definitions: goals, group: 'Goles', direction });
      pushOuRows(rows, { base, scored, definitions: cards, group: 'Tarjetas', direction });
    }

    for (const market of RESULT_MARKETS) {
      rows.push({
        ...base,
        grupo: market.group,
        periodo: 'Partido',
        ambito: resolvedScope(market.scope, analysis),
        mercado: market.group,
        direccion: 'resultado',
        line_number: null,
        linea: market.label
          .replace('equipo local', analysis.homeTeam || 'equipo local')
          .replace('equipo visitante', analysis.awayTeam || 'equipo visitante'),
        market_key: market.key,
        ...metric(scored, market.key),
      });
    }

    for (const market of HANDICAP_MARKETS) {
      rows.push({
        ...base,
        grupo: 'Hándicap',
        periodo: 'Partido',
        ambito: analysis.homeTeam || 'Equipo local',
        mercado: 'Hándicap',
        direccion: 'handicap',
        line_number: market.line,
        linea: market.label.replace('Local', analysis.homeTeam || 'Local'),
        market_key: market.key,
        ...metric(scored, market.key),
      });
    }
  }
  return rows;
}

function fallbackReliability(sample) {
  const n = Number(sample) || 0;
  return n > 0 ? Math.min(0.69, n / (n + 12)) : null;
}

export function buildFootballFallbackEvidence(aggregate) {
  const evidence = {};
  for (const scope of FALLBACK_SCOPES) {
    for (const line of scope.lines) {
      const alias = marketKey(scope.key, 'over', line);
      const probability = Number(aggregate?.[alias]);
      const sample = Number(aggregate?.[`${alias}__n`]);
      if (!Number.isFinite(probability) || !Number.isFinite(sample) || sample < 1) continue;
      const shared = {
        level: 'global-fallback',
        n: sample,
        confidence: fallbackReliability(sample),
      };
      evidence[alias] = { ...shared, prob_final: probability, prob: probability };
      const underKey = marketKey(scope.key, 'under', line);
      evidence[underKey] = {
        ...shared,
        prob_final: Math.max(0, Math.min(1, 1 - probability)),
        prob: Math.max(0, Math.min(1, 1 - probability)),
      };
    }
  }
  return evidence;
}

async function loadFootballFallbackEvidence(date) {
  const select = [];
  for (const scope of FALLBACK_SCOPES) {
    for (const line of scope.lines) {
      const alias = marketKey(scope.key, 'over', line);
      select.push(
        `AVG(CASE WHEN ${scope.expression} IS NULL THEN NULL WHEN ${scope.expression} > ${Number(line)} THEN 1.0 ELSE 0.0 END)::float8 AS "${alias}"`,
        `COUNT(${scope.expression})::int AS "${alias}__n"`,
      );
    }
  }
  const cutoff = `${date}T05:00:00.000Z`;
  const { rows } = await pgPool.query(
    `SELECT ${select.join(',\n')}
       FROM model.team_match_stats
      WHERE is_home=TRUE
        AND kickoff < $1::timestamptz
        AND kickoff >= $1::timestamptz - INTERVAL '730 days'`,
    [cutoff],
  );
  return buildFootballFallbackEvidence(rows[0] || {});
}

function csvCell(value) {
  if (value == null) return '—';
  const text = String(value);
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${Number(value).toFixed(2).replace('.', ',')}%`;
}

export function renderFootballPersonalMarketCsv(rows) {
  const header = ['Partido', 'Hora', 'Línea', 'Probabilidad', 'Fiabilidad'];
  const body = (rows || [])
    .filter(row => row.probability != null && row.reliability != null)
    .map(row => [
      row.partido,
      row.hora_bogota,
      `${row.periodo} · ${row.ambito} · ${row.mercado}: ${row.linea}`,
      formatPercent(row.probability),
      formatPercent(row.reliability),
    ].map(csvCell).join(';'));
  return `\uFEFF${[header.join(';'), ...body].join('\n')}\n`;
}

export async function buildFootballPersonalMarketReport(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error('Fecha inválida para el informe de mercados');
  }
  const { rows } = await pgPool.query(
    `SELECT fixture_id,date,analysis
       FROM match_analysis
      WHERE date=$1 AND cache_version >= 20
      ORDER BY COALESCE(analysis->>'kickoff', analysis->'analysis'->>'kickoff'), fixture_id`,
    [date],
  );
  const fallbackEvidence = await loadFootballFallbackEvidence(date);
  const reportRows = buildFootballPersonalMarketRows(rows, date, fallbackEvidence);
  const completeRows = reportRows.filter(row => row.probability != null && row.reliability != null);
  return {
    date,
    sport: 'futbol',
    fixtures: rows.length,
    rows: completeRows.length,
    omittedRows: reportRows.length - completeRows.length,
    fixturesWithData: new Set(completeRows.map(row => row.fixture_id)).size,
    filename: `CF_mercados_${date}.csv`,
    reportRows: completeRows,
    content: renderFootballPersonalMarketCsv(completeRows),
  };
}
