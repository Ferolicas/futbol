// Apuestas sin dinero — lógica pura (sin base de datos).
//
// Registro personal de las apuestas que el propietario abre de verdad, con un
// importe ficticio. Va aparte de las recomendaciones: aquí no se calcula
// ninguna probabilidad, solo se clasifica lo apostado y se mide cómo salió.

export const PAPER_BET_FAMILIES = Object.freeze({
  ganador: 'Ganador',
  handicap: 'Hándicap',
  total: 'Total de goles/puntos',
  total_equipo: 'Total de un equipo',
  corners: 'Córners',
  tarjetas: 'Tarjetas',
  ambos_marcan: 'Ambos marcan',
  jugador: 'Jugador',
  otros: 'Otros',
});

const PERIODS = [
  [/^quarter1\b|1\.?\s*[ºer]*\s*cuarto|primer cuarto/i, '1.er cuarto'],
  [/^quarter[234]\b|[234]\.?\s*[ºoer]*\s*cuarto/i, 'otro cuarto'],
  [/^firsthalf\b|1\.?\s*ª?\s*mitad|primera mitad|1\.?\s*er tiempo|primer tiempo|\b1t\b/i, '1.ª mitad'],
  [/^secondhalf\b|2\.?\s*ª?\s*mitad|segunda mitad|segundo tiempo|\b2t\b/i, '2.ª mitad'],
  [/^(inning\d|first\d)|entrada/i, 'entradas'],
];

function plain(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Familia de mercado de una selección, a partir de su ID y de su nombre. */
export function classifyMarketFamily({ id, name, scope } = {}) {
  const key = plain(id);
  const text = plain(name);
  if (scope === 'player' || /^player-/.test(key)) return 'jugador';
  if (/corner/.test(key) || /corner/.test(text)) return 'corners';
  if (/card|tarjeta|amarilla|roja/.test(key) || /tarjeta|amarilla|roja/.test(text)) return 'tarjetas';
  if (/btts|bothscore|ambos/.test(key) || /ambos (equipos )?(marcan|anotan)/.test(text)) return 'ambos_marcan';
  if (/handicap|spread/.test(key) || /handicap/.test(text) || /\s[+-]\d+(?:[.,]\d+)?(\s|$)/.test(` ${text}`)) return 'handicap';
  if (/team-total|teamtotal/.test(key)) return 'total_equipo';
  if (/(^|-)(ml|moneyline)(-|$)|winner|1x2|doublechance/.test(key)
    || /\bgana\b|ganador|empate|doble oportunidad|resultado final/.test(text)) return 'ganador';
  if (/mas de|menos de|over|under/.test(text) || /(^|-)total(-|$)|over|under/.test(key)) {
    // "Equipo: más de 99.5 puntos" es el total de ese equipo, no del partido.
    return /:\s*(mas|menos) de/.test(text) ? 'total_equipo' : 'total';
  }
  return 'otros';
}

export function classifyMarketPeriod({ id, name } = {}) {
  const key = plain(id);
  const text = plain(name);
  for (const [pattern, label] of PERIODS) if (pattern.test(key) || pattern.test(text)) return label;
  return null;
}

/** Equipo sobre el que trata la selección, o null si es del partido entero. */
export function legTeamSide({ id, name, side, homeTeam, awayTeam } = {}) {
  const text = plain(name);
  const home = plain(homeTeam);
  const away = plain(awayTeam);
  const mentionsHome = home.length >= 3 && text.includes(home);
  const mentionsAway = away.length >= 3 && text.includes(away);
  if (mentionsHome !== mentionsAway) return mentionsHome ? 'home' : 'away';
  if (side === 'home' || side === 'away') return side;
  const key = plain(id);
  if (/(^|[-_])home([-_]|$)|local/.test(key)) return 'home';
  if (/(^|[-_])away([-_]|$)|visit/.test(key)) return 'away';
  return null;
}

export function splitMatchName(matchName) {
  const parts = String(matchName || '').split(/\s+vs\.?\s+|\s+@\s+/i).map((part) => part.trim());
  return parts.length === 2 && parts[0] && parts[1] ? { home: parts[0], away: parts[1] } : { home: null, away: null };
}

const round2 = (value) => Math.round(Number(value) * 100) / 100;

/** ¿Hay más de una selección del mismo partido? (la «Crear apuesta» de la casa) */
export function hasSameMatchSelections(selections) {
  const seen = new Set();
  for (const selection of selections || []) {
    const key = String(selection.fixtureId ?? selection.fixture_id ?? '');
    if (!key) continue;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * Agrupa las selecciones en lo que la casa cotiza como una sola cuota: cada
 * selección suelta es un grupo, y varias del mismo partido con cuota conjunta
 * («Crear apuesta») forman un único grupo. Multiplicar las cuotas sueltas de un
 * mismo partido daría un precio que la casa no ofrece, porque esos mercados no
 * son independientes.
 */
export function oddGroups(legs) {
  const groups = new Map();
  (legs || []).forEach((leg, index) => {
    const groupOdd = Number(leg.group_odd ?? leg.groupOdd);
    const fixture = leg.fixture_id ?? leg.fixtureId;
    const builder = Number.isFinite(groupOdd) && groupOdd >= 1 && fixture != null;
    const key = builder ? `builder|${leg.sport || ''}|${fixture}` : `single|${index}`;
    if (!groups.has(key)) groups.set(key, { odd: builder ? groupOdd : Number(leg.odd || 1), legs: [] });
    groups.get(key).legs.push(leg);
  });
  return [...groups.values()];
}

export function combinedOdd(legs) {
  const odd = oddGroups(legs).reduce((product, group) => product * group.odd, 1);
  return Math.round(odd * 1000) / 1000;
}

/**
 * Estado de la apuesta según sus selecciones. Una perdida la pierde entera
 * aunque queden otras por jugarse. Un grupo con alguna selección nula sale de
 * la combinada con cuota 1, igual que en la casa.
 */
export function betOutcome(stake, legs) {
  const list = legs || [];
  if (!list.length) return { status: 'open', payout: null };
  if (list.some((leg) => leg.status === 'lost')) return { status: 'lost', payout: 0 };
  if (list.some((leg) => leg.status === 'pending')) return { status: 'open', payout: null };
  const wonGroups = oddGroups(list).filter((group) => group.legs.every((leg) => leg.status === 'won'));
  if (!wonGroups.length) return { status: 'void', payout: round2(stake) };
  const odd = wonGroups.reduce((product, group) => product * group.odd, 1);
  return { status: 'won', payout: round2(Number(stake) * odd) };
}

function emptyStats() {
  return { bets: 0, open: 0, won: 0, lost: 0, void: 0, staked: 0, returned: 0 };
}

function finishStats(stats) {
  const decided = stats.won + stats.lost;
  return {
    ...stats,
    staked: round2(stats.staked),
    returned: round2(stats.returned),
    profit: round2(stats.returned - stats.staked),
    roi: stats.staked > 0 ? round2(((stats.returned - stats.staked) / stats.staked) * 100) : null,
    hitRate: decided > 0 ? round2((stats.won / decided) * 100) : null,
  };
}

/** Resumen de dinero ficticio. Las apuestas abiertas no cuentan como apostado cerrado. */
export function summarizeBets(bets) {
  const stats = emptyStats();
  for (const bet of bets || []) {
    stats.bets += 1;
    stats[bet.status] += 1;
    if (bet.status === 'open') continue;
    stats.staked += Number(bet.stake);
    stats.returned += Number(bet.payout || 0);
  }
  return finishStats(stats);
}

function legStats() {
  return { legs: 0, won: 0, lost: 0, void: 0, pending: 0, oddSum: 0 };
}

function finishLegStats(stats) {
  const decided = stats.won + stats.lost;
  return {
    legs: stats.legs, won: stats.won, lost: stats.lost, void: stats.void, pending: stats.pending,
    hitRate: decided > 0 ? round2((stats.won / decided) * 100) : null,
    averageOdd: stats.legs > 0 ? round2(stats.oddSum / stats.legs) : null,
  };
}

/**
 * Analítica por selección: cada selección cuenta por separado (una combinada
 * perdida puede tener selecciones acertadas). Devuelve el rendimiento por
 * familia de mercado y por equipo dentro de cada familia. Una selección del
 * partido entero (total, ambos marcan) se anota a los dos equipos.
 */
export function analyzeLegs(legs) {
  const families = new Map();
  const teams = new Map();
  const bump = (stats, leg) => {
    stats.legs += 1;
    stats[leg.status] += 1;
    stats.oddSum += Number(leg.odd || 0);
  };
  for (const leg of legs || []) {
    const family = leg.market_family || leg.marketFamily || 'otros';
    const sport = leg.sport || 'football';
    const familyKey = `${sport}|${family}`;
    if (!families.has(familyKey)) families.set(familyKey, { sport, family, ...legStats() });
    bump(families.get(familyKey), leg);
    const side = leg.team_side ?? leg.teamSide ?? null;
    const home = leg.home_team ?? leg.homeTeam;
    const away = leg.away_team ?? leg.awayTeam;
    const involved = side === 'home' ? [home] : side === 'away' ? [away] : [home, away];
    for (const team of involved.filter(Boolean)) {
      const teamKey = `${sport}|${family}|${team}`;
      if (!teams.has(teamKey)) teams.set(teamKey, { sport, family, team, ...legStats() });
      bump(teams.get(teamKey), leg);
    }
  }
  const order = (left, right) => (right.hitRate ?? -1) - (left.hitRate ?? -1) || right.legs - left.legs;
  return {
    families: [...families.values()].map((row) => ({ sport: row.sport, family: row.family, ...finishLegStats(row) })).sort(order),
    teams: [...teams.values()].map((row) => ({ sport: row.sport, family: row.family, team: row.team, ...finishLegStats(row) })).sort(order),
  };
}
