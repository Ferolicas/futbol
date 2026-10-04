import { marketResultState, settleMarketSelection } from './market-settlement.js';

const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

function scorePair(result, liveStats) {
  const goals = result?.goals || liveStats?.goals || {};
  const fulltime = result?.score?.fulltime || liveStats?.score?.fulltime || {};
  const numeric = value => value === null || value === undefined || value === ''
    ? null
    : (Number.isFinite(Number(value)) ? Number(value) : null);
  const home = numeric(goals.home ?? fulltime.home);
  const away = numeric(goals.away ?? fulltime.away);
  return {
    home,
    away,
  };
}

function completeCounter(primary, fallback) {
  const usable = value => value && value.isReal !== false
    && [value.home, value.away, value.total]
      .some(item => item !== null && item !== undefined && Number.isFinite(Number(item)));
  return usable(primary) ? primary : fallback;
}

function officialSnapshot(result, liveStats) {
  return {
    ...(liveStats || {}),
    ...(result || {}),
    status: result?.status || liveStats?.status,
    goals: result?.goals || liveStats?.goals,
    score: result?.score || liveStats?.score,
    corners: completeCounter(result?.corners, liveStats?.corners),
    yellowCards: completeCounter(result?.yellow_cards, liveStats?.yellowCards),
    redCards: completeCounter(result?.red_cards, liveStats?.redCards),
    goalScorers: result?.goal_scorers || liveStats?.goalScorers || [],
    cardEvents: result?.card_events || liveStats?.cardEvents || [],
    realFinal: true,
  };
}

/**
 * Liquida exclusivamente las opciones guardadas tras la confirmación del bot
 * diario. No vuelve a ejecutar el motor ni sustituye el snapshot enviado.
 */
export function buildTelegramMatchResult({ publicationId, dailyPickId, date, match, result, liveStats } = {}) {
  const sourceId = publicationId || dailyPickId;
  if (!sourceId || !match?.fixtureId || !Array.isArray(match.options) || !match.options.length) {
    return null;
  }

  const liveResult = officialSnapshot(result, liveStats);
  const game = {
    fixture: {
      id: Number(match.fixtureId),
      date: match.kickoff || null,
      status: liveResult.status || { short: 'NS' },
    },
    teams: {
      home: { id: match.homeId, name: match.homeTeam || 'Local' },
      away: { id: match.awayId, name: match.awayTeam || 'Visitante' },
    },
    goals: liveResult.goals || null,
    score: liveResult.score || null,
  };
  if (!marketResultState({ sport: 'football', game, liveResult }).isFinal) return null;

  const options = match.options.map(option => ({
    id: option.id,
    name: option.name || option.category || option.id || 'Opción',
    outcome: settleMarketSelection({ sport: 'football', selection: option, game, liveResult }),
  }));
  if (options.some(option => !['won', 'lost', 'void'].includes(option.outcome?.status))) return null;

  const score = scorePair(result, liveStats);
  if (score.home == null || score.away == null) return null;
  const won = options.filter(option => option.outcome.status === 'won').length;
  const lost = options.filter(option => option.outcome.status === 'lost').length;
  const voided = options.filter(option => option.outcome.status === 'void').length;
  const home = match.homeTeam || 'Local';
  const away = match.awayTeam || 'Visitante';
  const label = status => ({ won: '✅ GANADA', lost: '❌ PERDIDA', void: '🟡 NULA' })[status];
  const optionLines = options.map(option => `${label(option.outcome.status)} — ${escapeHtml(option.name)}`);
  const message = [
    '🏁 <b>RESULTADO FINAL</b>',
    '',
    `<b>${escapeHtml(home)} ${score.home}–${score.away} ${escapeHtml(away)}</b>`,
    '',
    ...optionLines,
    '',
    `<b>Balance:</b> ${won} ganada${won === 1 ? '' : 's'} · ${lost} perdida${lost === 1 ? '' : 's'}`
      + (voided ? ` · ${voided} nula${voided === 1 ? '' : 's'}` : ''),
  ].join('\n');

  return {
    publicationId: sourceId,
    combinadaId: dailyPickId || undefined,
    fixtureId: Number(match.fixtureId),
    date,
    kickoff: match.kickoff || null,
    homeTeam: home,
    awayTeam: away,
    score,
    won,
    lost,
    voided,
    options,
    message,
  };
}
