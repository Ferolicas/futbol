import { meetsReliability, reliabilityPercent } from './recommendation-policy.js';
import { entryReliabilityPercent } from './reliability.js';

// supabase.js construye el pool de Postgres al cargarse; se importa perezoso
// dentro de los builders para que las funciones puras de este módulo puedan
// usarse (y testearse) sin base de datos ni variables de entorno.
async function db() {
  const { supabaseAdmin } = await import('./supabase.js');
  return supabaseAdmin;
}

/**
 * Picks Premium de Telegram — segundo canal, reglas propias.
 *
 * A diferencia de la Apuesta del Día (lib/telegram-daily-pick.js: hasta 2
 * partidos × 3 opciones, hándicap prohibido), este canal publica UNA imagen por deporte
 * con TODOS los partidos del día y TODAS sus opciones elegibles:
 *
 *   Fútbol   → solo hándicap, córners y goles; probabilidad >= 70 y
 *              fiabilidad >= 90.
 *   Béisbol  → carreras (partido/equipo/primeras 5), hits, bateadores,
 *              abridores y strikeouts; probabilidad >= 70 y fiabilidad >= 90,
 *              aunque no exista cuota.
 *
 * Este módulo NO toca el motor: lee los análisis ya calculados en
 * match_analysis / baseball_match_analysis, igual que hace
 * /api/cron/publish-combinada, y solo filtra su catálogo.
 */

const EPSILON = 1e-9;
const PREMATCH_BUFFER_MS = 5 * 60 * 1000;
const BETTABLE_FOOTBALL_STATUSES = new Set(['NS', 'TBD']);

export const FOOTBALL_PREMIUM_RULES = Object.freeze({
  minProbability: 70,
  minReliability: 90,
  groups: ['handicap', 'corners', 'goles'],
});

export const BASEBALL_PREMIUM_RULES = Object.freeze({
  minProbability: 70,
  minReliability: 90,
  groups: ['carreras', 'hits', 'bateadores', 'strikeouts'],
});

export const FOOTBALL_GROUP_LABELS = Object.freeze({
  handicap: 'HÁNDICAP',
  corners: 'CÓRNERS',
  goles: 'GOLES',
});

export const BASEBALL_GROUP_LABELS = Object.freeze({
  carreras: 'CARRERAS',
  hits: 'HITS · PARTIDO Y EQUIPO',
  bateadores: 'BATEADORES',
  strikeouts: 'STRIKEOUTS · LANZADORES',
});

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function displayName(value) {
  return String(value || '')
    .replace(/\bOver\b/gi, 'Más de')
    .replace(/\bUnder\b/gi, 'Menos de')
    .replace(/\bO\s*\/\s*U\b/gi, 'Más/Menos')
    .replace(/\s+/g, ' ')
    .trim();
}

// Política de producto compartida con la Apuesta del Día: la probabilidad se
// publica topada al 95%; la fiabilidad se muestra tal cual.
function displayProbability(value) {
  const probability = Math.max(0, Math.min(100, Number(value) || 0));
  if (probability >= 95) return 95;
  return Math.floor((probability + EPSILON) * 100) / 100;
}

function toOption(selection, confidence) {
  const rawProbability = Number(selection.rawProbability ?? selection.probability);
  const odd = Number(selection.odd);
  return {
    id: selection.id ?? null,
    name: displayName(selection.name),
    probability: displayProbability(rawProbability),
    rawProbability,
    confidence: reliabilityPercent(confidence),
    odd: Number.isFinite(odd) && odd > 0 ? odd : null,
  };
}

function compareOptions(a, b) {
  const probabilityDiff = b.rawProbability - a.rawProbability;
  if (Math.abs(probabilityDiff) > EPSILON) return probabilityDiff;
  const reliabilityDiff = (b.confidence || 0) - (a.confidence || 0);
  if (Math.abs(reliabilityDiff) > EPSILON) return reliabilityDiff;
  return String(a.id || a.name || '').localeCompare(String(b.id || b.name || ''));
}

function unwrapAnalysis(value) {
  if (!value || typeof value !== 'object') return {};
  if (value.analysis && typeof value.analysis === 'object'
      && (value.analysis.homeTeam || value.analysis.kickoff || value.analysis._scored)) {
    return value.analysis;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Fútbol
// ---------------------------------------------------------------------------

// Familias que jamás entran aunque su texto mencione goles (defensa ante
// nombres compuestos): resultado, doble oportunidad, ambos marcan, tarjetas,
// remates, faltas y fueras de juego.
const FOOTBALL_EXCLUDED = /btts|ambos\s+equipos|ambos\s+marcan|doble\s+oportunidad|(^|[^a-z])dc_|card|tarjet|winner|ganador|empate|draw|(^|[^a-z])1x2([^a-z]|$)|(^|[^a-z])sot([^a-z]|$)|shotson|shots-on|tiros?\s+a\s+puerta|remates?|foul|falta|offside|fuera\s+de\s+juego/;

export function classifyFootballPremiumOption(selection) {
  const id = normalize(selection?.id);
  const category = normalize(selection?.category);
  const name = normalize(selection?.name);
  const text = [id, category, name].filter(Boolean).join(' ');
  if (!text) return null;
  if (FOOTBALL_EXCLUDED.test(text)) return null;

  // Vocabulario real del context-engine: ah_* / eh_* (hándicap asiático y
  // europeo), *_corners_*, *_goals_* (incluidas mitades 1h/2h).
  if (/^(ah_|eh_)/.test(id) || /^(ah_|eh_)/.test(category) || /handicap|asian/.test(text)) {
    return 'handicap';
  }
  if (/corner/.test(text)) return 'corners';
  if (/goal|goles|(^|[^a-z])gol([^a-z]|$)/.test(text)) return 'goles';
  return null;
}

export function isFootballPremiumEligible(selection) {
  const probability = Number(selection?.rawProbability ?? selection?.probability);
  return Number.isFinite(probability)
    && probability + EPSILON >= FOOTBALL_PREMIUM_RULES.minProbability
    && meetsReliability(selection?.confidence, FOOTBALL_PREMIUM_RULES.minReliability);
}

/**
 * Ensambla los partidos publicables de fútbol a partir de filas crudas de
 * match_analysis. Puro: no toca la base de datos (testeable).
 */
export function assembleFootballPremiumMatches(rows, nowMs = Date.now()) {
  const matches = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const analysis = unwrapAnalysis(row?.analysis);
    const combinada = row?.combinada || analysis.combinada;
    if (combinada?.source !== 'context-engine') continue;

    const statusShort = analysis.status?.short || analysis.status;
    if (statusShort && !BETTABLE_FOOTBALL_STATUSES.has(statusShort)) continue;
    const kickoffMs = analysis.kickoff ? new Date(analysis.kickoff).getTime() : 0;
    if (kickoffMs > 0 && kickoffMs <= nowMs + PREMATCH_BUFFER_MS) continue;

    const scored = analysis._scored || row?.analysis?._scored || {};
    const pool = Array.isArray(combinada.selectable) && combinada.selectable.length
      ? combinada.selectable
      : (Array.isArray(combinada.selections) ? combinada.selections : []);

    const groups = { handicap: [], corners: [], goles: [] };
    const seen = new Set();
    for (const selection of pool) {
      const key = selection?.id || JSON.stringify(selection);
      if (seen.has(key)) continue;
      seen.add(key);
      const family = classifyFootballPremiumOption(selection);
      if (!family) continue;
      const evidence = scored?.[selection?.id];
      const confidence = selection?.confidence ?? evidence?.confidence ?? evidence?.conf;
      if (!isFootballPremiumEligible({ ...selection, confidence })) continue;
      groups[family].push(toOption(selection, confidence));
    }

    const optionsCount = groups.handicap.length + groups.corners.length + groups.goles.length;
    if (!optionsCount) continue;
    for (const family of Object.keys(groups)) groups[family].sort(compareOptions);

    matches.push({
      fixtureId: Number(row.fixture_id ?? row.fixtureId) || null,
      homeTeam: analysis.homeTeam || null,
      awayTeam: analysis.awayTeam || null,
      league: analysis.league || null,
      kickoff: analysis.kickoff || null,
      optionsCount,
      groups,
    });
  }

  matches.sort((a, b) => {
    const timeA = a.kickoff ? new Date(a.kickoff).getTime() : Infinity;
    const timeB = b.kickoff ? new Date(b.kickoff).getTime() : Infinity;
    if (timeA !== timeB) return timeA - timeB;
    return (a.fixtureId || 0) - (b.fixtureId || 0);
  });
  return matches;
}

export async function buildFootballPremiumBoard(date, nowMs = Date.now()) {
  const { data, error } = await (await db())
    .from('match_analysis')
    .select('fixture_id, analysis, combinada, cache_version')
    .eq('date', date)
    .gte('cache_version', 20);
  if (error) throw new Error(`match_analysis: ${error.message || error}`);

  const analyzedCount = Array.isArray(data) ? data.length : 0;
  const matches = assembleFootballPremiumMatches(data, nowMs);
  return {
    fecha: date,
    sport: 'futbol',
    analyzedCount,
    matches,
    totalOptions: matches.reduce((total, match) => total + match.optionsCount, 0),
    rules: FOOTBALL_PREMIUM_RULES,
  };
}

// ---------------------------------------------------------------------------
// Béisbol
// ---------------------------------------------------------------------------

export function classifyBaseballPremiumOption(selection) {
  if (selection?.family && BASEBALL_PREMIUM_RULES.groups.includes(selection.family)) {
    return selection.family;
  }
  const category = String(selection?.category || '');
  if (category === 'moneyline' || /-moneyline$/.test(category)) return null;
  if (/^handicap-/.test(category) || /^(?:first|inning)\d+-handicap-/.test(category)) return null;
  if (/^total-/.test(category)
      || /^team-total-/.test(category)
      || /^(?:first|inning)\d+-(?:team-)?total-/.test(category)
      || /^(?:first|inning)\d+-run$/.test(category)) {
    return 'carreras';
  }
  if (/^stat-hits-/.test(category)) return 'hits';
  if (/^player-strikeouts-/.test(category)) return 'strikeouts';
  if (/^player-/.test(category)) return 'bateadores';
  if (/^special-/.test(category)) return null;
  return null;
}

export function isBaseballPremiumEligible(selection) {
  const probability = Number(selection?.rawProbability ?? selection?.probability);
  return Number.isFinite(probability)
    && probability + EPSILON >= BASEBALL_PREMIUM_RULES.minProbability
    && meetsReliability(
      selection?.reliability ?? selection?.confidence,
      BASEBALL_PREMIUM_RULES.minReliability,
    );
}

/**
 * Ensambla los juegos publicables de béisbol a partir de filas crudas. Puro.
 *
 * `bogotaDate` (opcional) limita a los juegos cuyo `start_time` cae en ese día
 * de Bogotá. Es necesario porque la columna `date` de baseball_match_analysis
 * guarda la fecha UTC del juego: la cartelera de un día de Bogotá queda
 * repartida entre dos fechas UTC (los juegos de las 19:00+ Bogotá pertenecen
 * al día UTC siguiente).
 */
function probabilityPercent(entry) {
  const raw = Number(entry?.rawProbability);
  if (Number.isFinite(raw)) return raw >= 0 && raw <= 1 ? raw * 100 : raw;
  const displayed = Number(entry?.probability ?? entry);
  return Number.isFinite(displayed) ? displayed : null;
}

function lineKey(value) {
  return String(value).replace('-', 'm').replace('.', '_');
}

function signedLine(value) {
  const line = Number(value);
  return Number.isFinite(line) && line > 0 ? `+${line}` : String(value);
}

function normalizedPersonName(value) {
  return normalize(value).replace(/[^a-z0-9]/g, '');
}

const PLAYER_LABELS = Object.freeze({
  hits: 'hits',
  homeRuns: 'jonrones',
  totalBases: 'bases totales',
  rbis: 'carreras impulsadas',
  runs: 'carreras anotadas',
  walks: 'bases por bolas',
  stolenBases: 'bases robadas',
  battingStrikeouts: 'ponches del bateador',
  strikeouts: 'ponches',
});

/**
 * Catálogo premium independiente de las cuotas. `combinada.selectable` sigue
 * aportando el precio real cuando existe, pero las probabilidades salen del
 * motor persistido y no desaparecen si Bet365 aún no publicó esa línea.
 */
export function buildBaseballPremiumCatalog(row) {
  const probabilities = row?.probabilities || {};
  // `probabilities` es el adaptador visual y en algunos bloques conserva solo
  // el porcentaje. `probabilities.evidence` es la predicción empírica completa
  // con n/hits por mercado: esa es la fuente canónica para calcular 90% de
  // fiabilidad sin depender de que exista una cuota.
  const model = probabilities.evidence && typeof probabilities.evidence === 'object'
    ? probabilities.evidence
    : probabilities;
  const priced = new Map((row?.combinada?.selectable || []).map((item) => [item.id, item]));
  const catalog = new Map();
  const home = row?.home_team || 'Local';
  const away = row?.away_team || 'Visitante';
  const teams = { home, away };

  const add = ({ id, category, family, name, entry, side = null, line = null }) => {
    const rawProbability = probabilityPercent(entry);
    if (!id || rawProbability == null) return;
    const pricedOption = priced.get(id);
    catalog.set(id, {
      id,
      category,
      family,
      name,
      probability: rawProbability,
      rawProbability,
      reliability: entryReliabilityPercent(entry, BASEBALL_PREMIUM_RULES.minProbability),
      odd: pricedOption?.odd ?? null,
      side,
      line,
    });
  };

  for (const team of ['home', 'away']) {
    add({
      id: `ml-${team}`, category: 'moneyline', family: 'ganador',
      name: `${teams[team]} gana`, entry: model.moneyline?.[team], side: team,
    });
  }

  for (const [line, values] of Object.entries(model.totals?.lines || {})) {
    for (const side of ['over', 'under']) add({
      id: `total-${line}-${side}`, category: `total-${line}`, family: 'carreras',
      name: `${side === 'over' ? 'Más' : 'Menos'} de ${line} carreras`,
      entry: values?.[side], side, line: Number(line),
    });
  }

  for (const team of ['home', 'away']) {
    for (const [line, entry] of Object.entries(model.spreads?.[team] || probabilities.runLines?.[team] || {})) add({
      id: `handicap-${team}-${lineKey(line)}`, category: `handicap-${line}`, family: 'handicap',
      name: `${teams[team]} ${signedLine(line)}`, entry, side: team, line: Number(line),
    });
    for (const [line, values] of Object.entries(model.teamTotals?.[team] || {})) {
      for (const side of ['over', 'under']) add({
        id: `team-total-${team}-${line}-${side}`,
        category: `team-total-${team}-${line}`, family: 'carreras',
        name: `${teams[team]}: ${side === 'over' ? 'más' : 'menos'} de ${line} carreras`,
        entry: values?.[side], side, line: Number(line),
      });
    }
  }

  const periods = (model.period || probabilities.f5) ? {
    first5: { label: 'primeras 5 entradas', ...(model.period || probabilities.f5) },
  } : {};
  for (const [periodKey, period] of Object.entries(periods)) {
    const label = period?.label || periodKey;
    for (const side of ['home', 'away', 'tie']) {
      const outcome = side === 'tie' ? 'draw' : side;
      add({
        id: `${periodKey}-moneyline-${outcome}`,
        category: `${periodKey}-moneyline`, family: 'ganador',
        name: side === 'tie' ? `Empate en ${label}` : `${teams[side]} gana en ${label}`,
        entry: period?.moneyline?.[side], side: outcome,
      });
    }
    for (const [line, values] of Object.entries(period?.totals || {})) {
      for (const side of ['over', 'under']) add({
        id: `${periodKey}-total-${line}-${side}`,
        category: `${periodKey}-total-${line}`, family: 'carreras',
        name: `${side === 'over' ? 'Más' : 'Menos'} de ${line} carreras en ${label}`,
        entry: values?.[side], side, line: Number(line),
      });
    }
    for (const team of ['home', 'away']) {
      for (const [line, values] of Object.entries(period?.teamTotals?.[team] || {})) {
        for (const side of ['over', 'under']) add({
          id: `${periodKey}-team-total-${team}-${line}-${side}`,
          category: `${periodKey}-team-total-${team}-${line}`, family: 'carreras',
          name: `${teams[team]}: ${side === 'over' ? 'más' : 'menos'} de ${line} carreras en ${label}`,
          entry: values?.[side], side, line: Number(line),
        });
      }
    }
    for (const side of ['yes', 'no']) add({
      id: `${periodKey}-run-${side}`, category: `${periodKey}-run`, family: 'carreras',
      name: `${side === 'yes' ? 'Sí' : 'No'} habrá carrera en ${label}`,
      entry: period?.run?.[side], side,
    });
  }

  for (const side of ['yes', 'no']) add({
    id: `btts-${side}`, category: 'btts', family: 'carreras',
    name: side === 'yes' ? 'Ambos equipos anotan 1+' : 'Algún equipo queda en blanco',
    entry: model.bothScore?.[side] ?? probabilities.btts?.[side], side,
  });

  for (const [metric, scopes] of Object.entries(model.statistics || {})) {
    if (metric !== 'hits') continue;
    for (const scope of ['total', 'home', 'away']) {
      const scopeName = scope === 'total' ? 'Ambos equipos' : teams[scope];
      for (const [line, values] of Object.entries(scopes?.[scope] || {})) {
        for (const side of ['over', 'under']) add({
          id: `stat-${metric}-${scope}-${line}-${side}`,
          category: `stat-${metric}-${scope}-${line}`, family: 'hits',
          name: `${scopeName}: ${side === 'over' ? 'más' : 'menos'} de ${line} hits`,
          entry: values?.[side], side, line: Number(line),
        });
      }
    }
  }

  for (const [metric, players] of Object.entries(probabilities.players || {})) {
    const family = metric === 'strikeouts' ? 'strikeouts' : 'bateadores';
    const label = PLAYER_LABELS[metric] || metric;
    for (const player of Array.isArray(players) ? players : []) {
      const playerKey = player.id || normalizedPersonName(player.name);
      for (const [line, sides] of Object.entries(player.lineSides || {})) {
        for (const side of ['over', 'under']) add({
          id: `player-${metric}-${playerKey}-${line}-${side}`,
          category: `player-${metric}-${normalizedPersonName(player.name)}`,
          family,
          name: `${player.name}: ${side === 'over' ? 'más' : 'menos'} de ${line} ${label}`,
          entry: sides?.[side], side, line: Number(line),
        });
      }
    }
  }

  const specials = model.specials || {};
  for (const outcome of ['odd', 'even']) add({
    id: `special-total-parity-${outcome}`, category: 'special-total-parity', family: 'especiales',
    name: `Total de carreras ${outcome === 'odd' ? 'impar' : 'par'}`,
    entry: specials.totalParity?.[outcome], side: outcome,
  });
  for (const team of ['home', 'away']) {
    for (const outcome of ['odd', 'even']) add({
      id: `special-team-parity-${team}-${outcome}`,
      category: `special-team-parity-${team}`, family: 'especiales',
      name: `${teams[team]}: total ${outcome === 'odd' ? 'impar' : 'par'}`,
      entry: specials.teamParity?.[team]?.[outcome], side: outcome,
    });
    add({
      id: `special-first-score-${team}`, category: 'special-first-score', family: 'especiales',
      name: `${teams[team]} anota primero`, entry: specials.firstTeamScore?.[team], side: team,
    });
    add({
      id: `special-last-score-${team}`, category: 'special-last-score', family: 'especiales',
      name: `${teams[team]} anota de último`, entry: specials.lastTeamScore?.[team], side: team,
    });
    add({
      id: `special-highest-${team}`, category: 'special-highest', family: 'especiales',
      name: `${teams[team]} termina con más carreras`, entry: specials.highestScoring?.[team], side: team,
    });
  }
  add({
    id: 'special-highest-draw', category: 'special-highest', family: 'especiales',
    name: 'Ambos equipos terminan con las mismas carreras',
    entry: specials.highestScoring?.draw, side: 'draw',
  });
  for (const side of ['yes', 'no']) add({
    id: `special-extra-innings-${side}`, category: 'special-extra-innings', family: 'especiales',
    name: `${side === 'yes' ? 'Sí' : 'No'} habrá entradas extra`,
    entry: specials.extraInnings?.[side], side,
  });
  for (const [score, entry] of Object.entries(specials.correctScore || {})) add({
    id: `special-correct-score-${score.replace(':', '-')}`,
    category: 'special-correct-score', family: 'especiales',
    name: `Marcador exacto ${score}`, entry,
  });
  const outcomeName = (outcome) => outcome === '1' || normalize(outcome) === 'home'
    ? home
    : (outcome === '2' || normalize(outcome) === 'away' ? away : 'Empate');
  for (const [key, entry] of Object.entries(specials.halfFull || {})) {
    const [first5, final] = key.split('/');
    add({
      id: `special-half-full-${key.replace(/[^a-z0-9]/gi, '-')}`,
      category: 'special-half-full', family: 'especiales',
      name: `Primeras 5: ${outcomeName(first5)} · Final: ${outcomeName(final)}`,
      entry,
    });
  }
  for (const [key, entry] of Object.entries(specials.resultTotals || {})) {
    const [outcome, total] = key.split('/');
    const localizedTotal = String(total || '')
      .replace(/Over/i, 'más de')
      .replace(/Under/i, 'menos de');
    add({
      id: `special-result-total-${key.replace(/[^a-z0-9]/gi, '-')}`,
      category: 'special-result-total', family: 'especiales',
      name: `${outcomeName(outcome)} y ${localizedTotal} carreras`,
      entry,
    });
  }

  // Conserva mercados ya catalogados con cuota que todavía no estén en el
  // shape visual, por ejemplo algunos hándicaps y especiales del proveedor.
  for (const selection of priced.values()) {
    if (catalog.has(selection.id)) continue;
    const family = classifyBaseballPremiumOption(selection);
    if (family) catalog.set(selection.id, { ...selection, family });
  }
  return [...catalog.values()];
}

export function assembleBaseballPremiumMatches(rows, nowMs = Date.now(), bogotaDate = null) {
  const matches = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const startMs = row?.start_time ? new Date(row.start_time).getTime() : 0;
    if (!startMs || startMs <= nowMs + PREMATCH_BUFFER_MS) continue;
    if (bogotaDate && bogotaDayOf(row.start_time) !== bogotaDate) continue;

    const pool = buildBaseballPremiumCatalog(row);
    const groups = Object.fromEntries(BASEBALL_PREMIUM_RULES.groups.map((family) => [family, []]));
    for (const selection of pool) {
      const family = classifyBaseballPremiumOption(selection);
      if (!family) continue;
      if (!isBaseballPremiumEligible(selection)) continue;
      groups[family].push(toOption(selection, selection?.reliability ?? selection?.confidence));
    }

    const optionsCount = Object.values(groups).reduce((total, list) => total + list.length, 0);
    if (!optionsCount) continue;
    for (const family of Object.keys(groups)) groups[family].sort(compareOptions);

    matches.push({
      fixtureId: Number(row.fixture_id ?? row.fixtureId) || null,
      homeTeam: row.home_team || null,
      awayTeam: row.away_team || null,
      league: row.league_name || null,
      kickoff: row.start_time || null,
      pitchers: row?.probabilities?.pitchers || null,
      optionsCount,
      groups,
    });
  }

  matches.sort((a, b) => {
    const timeA = a.kickoff ? new Date(a.kickoff).getTime() : Infinity;
    const timeB = b.kickoff ? new Date(b.kickoff).getTime() : Infinity;
    if (timeA !== timeB) return timeA - timeB;
    return (a.fixtureId || 0) - (b.fixtureId || 0);
  });
  return matches;
}

export async function buildBaseballPremiumBoard(date, nowMs = Date.now()) {
  // La cartelera del día Bogotá `date` vive en dos fechas UTC de la tabla
  // (ver assembleBaseballPremiumMatches): se piden ambas y se filtra por el
  // día Bogotá real de cada start_time.
  const { data, error } = await (await db())
    .from('baseball_match_analysis')
    .select('fixture_id, date, league_name, home_team, away_team, status, start_time, probabilities, combinada')
    .in('date', [date, shiftIsoDate(date, 1)]);
  if (error) throw new Error(`baseball_match_analysis: ${error.message || error}`);

  const rows = Array.isArray(data) ? data : [];
  const analyzedCount = rows.filter((row) => row?.start_time && bogotaDayOf(row.start_time) === date).length;
  const matches = assembleBaseballPremiumMatches(rows, nowMs, date);
  return {
    fecha: date,
    sport: 'baseball',
    analyzedCount,
    matches,
    totalOptions: matches.reduce((total, match) => total + match.optionsCount, 0),
    rules: BASEBALL_PREMIUM_RULES,
  };
}

// El día del béisbol se cuenta en Bogotá, igual que el motor (bogotaToday del
// worker); en-CA produce YYYY-MM-DD directamente.
export function bogotaToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function bogotaDayOf(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return bogotaToday(date);
}

export function shiftIsoDate(isoDate, days) {
  const value = new Date(`${isoDate}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function utcToday(now = new Date()) {
  return now.toISOString().split('T')[0];
}
