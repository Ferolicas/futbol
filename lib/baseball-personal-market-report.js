import { pgPool } from './db.js';
import {
  bogotaDayOf,
  buildBaseballPremiumCatalog,
  shiftIsoDate,
} from './telegram-premium-picks.js';

const PERIOD_LABELS = Object.freeze({
  inning1: '1.ª entrada',
  first3: 'Primeras 3 entradas',
  first5: 'Primeras 5 entradas',
});

function displayTime(value) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function directionRank(value) {
  if (value === 'over') return 0;
  if (value === 'under') return 1;
  return 2;
}

function classify(selection) {
  const category = String(selection?.category || '');
  const line = Number(selection?.line);
  const period = category.match(/^(inning1|first3|first5)-/)?.[1] || null;

  if (/^team-total-(?:home|away)-/.test(category) && line >= 1.5) {
    return { group: 'Carreras por equipo', period: 'Partido' };
  }
  if (/^stat-hits-(?:home|away)-/.test(category)) {
    return { group: 'Hits por equipo', period: 'Partido' };
  }
  if (/^player-strikeouts-/.test(category)) {
    return { group: 'Ponches del lanzador', period: 'Partido' };
  }
  if (/^stat-hits-total-/.test(category)) {
    return { group: 'Hits del partido', period: 'Partido' };
  }
  if (/^total-/.test(category)) {
    return { group: 'Carreras del partido', period: 'Partido' };
  }
  if (/^handicap-/.test(category)) {
    return { group: 'Hándicap', period: 'Partido' };
  }
  if (period && new RegExp(`^${period}-(?:team-)?total-`).test(category)) {
    return { group: 'Carreras por entradas', period: PERIOD_LABELS[period] };
  }
  if (period && new RegExp(`^${period}-run$`).test(category)) {
    return { group: 'Carreras por entradas', period: PERIOD_LABELS[period] };
  }
  if (period && new RegExp(`^${period}-stat-hits-`).test(category)) {
    return { group: 'Hits por entradas', period: PERIOD_LABELS[period] };
  }
  return null;
}

export function buildBaseballPersonalMarketRows(analyses, date) {
  const rows = [];
  for (const stored of analyses || []) {
    if (date && bogotaDayOf(stored?.start_time) !== date) continue;
    const base = {
      fecha: date || stored.date || '',
      hora_bogota: displayTime(stored.start_time),
      fixture_id: String(stored.fixture_id || ''),
      liga: stored.league_name || 'MLB',
      partido: `${stored.home_team || 'Local'} vs ${stored.away_team || 'Visitante'}`,
    };
    for (const selection of buildBaseballPremiumCatalog(stored)) {
      const definition = classify(selection);
      if (!definition || selection.probability == null) continue;
      rows.push({
        ...base,
        grupo: definition.group,
        periodo: definition.period,
        ambito: selection.name?.split(':')[0] || 'Partido',
        mercado: definition.group,
        direccion: selection.side || 'resultado',
        line_number: Number.isFinite(Number(selection.line)) ? Number(selection.line) : null,
        linea: selection.name,
        market_key: selection.id,
        probability: Number(selection.probability),
        reliability: Number.isFinite(Number(selection.reliability)) ? Number(selection.reliability) : null,
        sample: Number.isFinite(Number(selection.sampleN)) ? Number(selection.sampleN) : null,
        odd: Number.isFinite(Number(selection.odd)) ? Number(selection.odd) : null,
      });
    }
  }
  return rows.sort((left, right) => (
    String(left.hora_bogota).localeCompare(String(right.hora_bogota))
    || String(left.fixture_id).localeCompare(String(right.fixture_id))
    || directionRank(left.direccion) - directionRank(right.direccion)
    || String(left.grupo).localeCompare(String(right.grupo), 'es')
    || Number(left.line_number || 0) - Number(right.line_number || 0)
    || String(left.linea).localeCompare(String(right.linea), 'es')
  ));
}

function csvCell(value) {
  if (value == null) return '—';
  const text = String(value);
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function percent(value) {
  return value == null ? '—' : `${Number(value).toFixed(2).replace('.', ',')}%`;
}

export function renderBaseballPersonalMarketCsv(rows) {
  const header = ['Partido', 'Hora', 'Grupo', 'Mercado', 'Probabilidad', 'Fiabilidad', 'Cuota'];
  const body = (rows || []).map(row => [
    row.partido, row.hora_bogota, row.grupo, `${row.periodo} · ${row.linea}`,
    percent(row.probability), percent(row.reliability), row.odd == null ? '—' : Number(row.odd).toFixed(2),
  ].map(csvCell).join(';'));
  return `\uFEFF${[header.join(';'), ...body].join('\n')}\n`;
}

export async function buildBaseballPersonalMarketReport(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('Fecha inválida para el informe de béisbol');
  const { rows } = await pgPool.query(
    `SELECT fixture_id,date,league_name,home_team,away_team,start_time,probabilities,combinada
       FROM baseball_match_analysis
      WHERE date=ANY($1::date[])
      ORDER BY start_time,fixture_id`,
    [[date, shiftIsoDate(date, 1)]],
  );
  const reportRows = buildBaseballPersonalMarketRows(rows, date);
  return {
    date,
    sport: 'baseball',
    fixtures: new Set(rows.filter(row => bogotaDayOf(row.start_time) === date).map(row => row.fixture_id)).size,
    fixturesWithData: new Set(reportRows.map(row => row.fixture_id)).size,
    rows: reportRows.length,
    filename: `CF_baseball_${date}.csv`,
    reportRows,
    content: renderBaseballPersonalMarketCsv(reportRows),
  };
}
