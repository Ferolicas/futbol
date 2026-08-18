import { pgPool } from './db.js';

const CORNER_LINES = [8.5, 9.5, 10.5];
const GOAL_LINES = [0.5, 1.5, 2.5];

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

export function buildFootballPersonalMarketRows(analyses, date) {
  const rows = [];
  for (const stored of analyses || []) {
    const analysis = unwrapAnalysis(stored.analysis || stored);
    const scored = analysis._scored || {};
    const base = {
      fecha: date || stored.date || analysis.date || '',
      hora_bogota: formatKickoff(analysis.kickoff),
      fixture_id: Number(stored.fixture_id ?? analysis.fixtureId) || '',
      liga: analysis.league || '',
      partido: `${analysis.homeTeam || 'Local'} vs ${analysis.awayTeam || 'Visitante'}`,
    };

    for (const line of CORNER_LINES) {
      for (const direction of ['over', 'under']) {
        const key = marketKey('total_corners', direction, line);
        rows.push({
          ...base,
          periodo: 'Partido',
          ambito: 'Total partido',
          mercado: 'Córners',
          linea: directionLabel('Córners', direction, line),
          market_key: key,
          ...metric(scored, key),
        });
      }
    }

    for (const scope of GOAL_SCOPES) {
      for (const line of GOAL_LINES) {
        for (const direction of ['over', 'under']) {
          const key = marketKey(scope.key, direction, line);
          rows.push({
            ...base,
            periodo: scope.period,
            ambito: scope.scope
              .replace('Equipo local', analysis.homeTeam || 'Equipo local')
              .replace('Equipo visitante', analysis.awayTeam || 'Equipo visitante')
              .replace('Local ', `${analysis.homeTeam || 'Local'} `)
              .replace('Visitante ', `${analysis.awayTeam || 'Visitante'} `),
            mercado: 'Goles',
            linea: directionLabel('Goles', direction, line),
            market_key: key,
            ...metric(scored, key),
          });
        }
      }
    }
  }
  return rows;
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
  const header = [
    'Fecha', 'Hora Bogotá', 'Fixture', 'Liga', 'Partido', 'Periodo', 'Ámbito',
    'Mercado', 'Línea', 'Probabilidad', 'Fiabilidad', 'Muestra', 'Clave interna',
  ];
  const body = (rows || []).map(row => [
    row.fecha, row.hora_bogota, row.fixture_id, row.liga, row.partido,
    row.periodo, row.ambito, row.mercado, row.linea,
    formatPercent(row.probability), formatPercent(row.reliability), row.sample,
    row.market_key,
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
  const reportRows = buildFootballPersonalMarketRows(rows, date);
  return {
    date,
    fixtures: rows.length,
    rows: reportRows.length,
    filename: `CF_mercados_${date}.csv`,
    content: renderFootballPersonalMarketCsv(reportRows),
  };
}
