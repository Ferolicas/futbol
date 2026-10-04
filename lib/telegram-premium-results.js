import { marketResultState, settleMarketSelection } from './market-settlement.js';

const MAX_MESSAGE_LENGTH = 3600;

const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
export function premiumMatchOptions(match) {
  if (!match?.groups || typeof match.groups !== 'object') return [];
  return Object.values(match.groups)
    .flatMap(options => Array.isArray(options) ? options : [])
    .filter(option => option?.id && (option?.name || option?.category));
}

function footballLiveResult(result, liveStats) {
  const completeCounter = (primary, fallback) => {
    const usable = value => value && value.isReal !== false
      && [value.home, value.away, value.total]
        .some(item => item != null && Number.isFinite(Number(item)));
    return usable(primary) ? primary : fallback;
  };
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
    player_stats: liveStats?.player_stats || liveStats?.playerStats || {},
    realFinal: true,
  };
}

function gameAndLive(sport, match, result, liveStats) {
  if (sport === 'football') {
    const live = footballLiveResult(result, liveStats);
    return {
      live,
      game: {
        fixture: {
          id: Number(match.fixtureId),
          date: match.kickoff || null,
          status: live.status || { short: 'NS' },
        },
        teams: {
          home: { name: match.homeTeam || 'Local' },
          away: { name: match.awayTeam || 'Visitante' },
        },
        goals: live.goals || null,
        score: live.score || null,
      },
    };
  }
  const live = {
    ...(result || {}),
    player_stats: liveStats?.player_stats || liveStats?.playerStats || {},
  };
  return {
    live,
    game: {
      id: Number(match.fixtureId),
      status: { short: result?.status || 'NS' },
      scores: {
        home: { total: finite(result?.home_score) },
        away: { total: finite(result?.away_score) },
      },
      liveResult: live,
    },
  };
}

function scoreFor(sport, game, live) {
  if (sport === 'football') {
    return {
      home: finite(live?.score?.fulltime?.home ?? live?.goals?.home ?? game?.goals?.home),
      away: finite(live?.score?.fulltime?.away ?? live?.goals?.away ?? game?.goals?.away),
    };
  }
  return {
    home: finite(live?.home_score ?? game?.scores?.home?.total),
    away: finite(live?.away_score ?? game?.scores?.away?.total),
  };
}

function optionLine(option) {
  const icon = option.outcome.status === 'won' ? '✅ GANADA'
    : option.outcome.status === 'lost' ? '❌ PERDIDA'
      : '↩️ NULA';
  return `${icon} — ${escapeHtml(option.name)}`;
}

function splitLines(header, lines, footer) {
  const chunks = [];
  let current = [];
  for (const line of lines) {
    const candidate = [...header, ...current, line, ...footer].join('\n');
    if (candidate.length > MAX_MESSAGE_LENGTH && current.length) {
      chunks.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Liquida exclusivamente el snapshot que Telegram confirmó como enviado.
 * Nunca reconstruye el catálogo Premium ni usa la Apuesta del Día.
 */
export function buildTelegramPremiumMatchResults({ publicationId, sport, date, match, result, liveStats } = {}) {
  if (!publicationId || !['football', 'baseball'].includes(sport) || !match?.fixtureId) return [];
  const sourceOptions = premiumMatchOptions(match);
  if (!sourceOptions.length) return [];

  const { game, live } = gameAndLive(sport, match, result, liveStats);
  if (!marketResultState({ sport, game, liveResult: live }).isFinal) return [];
  const options = sourceOptions.map(option => ({
    ...option,
    name: option.name || option.category || option.id,
    outcome: settleMarketSelection({ sport, selection: option, game, liveResult: live }),
  }));
  if (options.some(option => !['won', 'lost', 'void'].includes(option.outcome?.status))) return [];

  const score = scoreFor(sport, game, live);
  if (score.home == null || score.away == null) return [];
  const won = options.filter(option => option.outcome.status === 'won').length;
  const lost = options.filter(option => option.outcome.status === 'lost').length;
  const voided = options.length - won - lost;
  const home = match.homeTeam || 'Local';
  const away = match.awayTeam || 'Visitante';
  const header = [
    '🏁 <b>RESULTADOS PICKS PREMIUM</b>',
    '',
    `<b>${escapeHtml(home)} ${score.home}–${score.away} ${escapeHtml(away)}</b>`,
    '',
  ];
  const balance = `<b>Balance:</b> ${won} ganada${won === 1 ? '' : 's'} · ${lost} perdida${lost === 1 ? '' : 's'}${voided ? ` · ${voided} nula${voided === 1 ? '' : 's'}` : ''}`;
  const optionChunks = splitLines(header, options.map(optionLine), ['', balance]);
  return optionChunks.map((chunk, index) => ({
    publicationId,
    part: index + 1,
    parts: optionChunks.length,
    sport,
    fixtureId: String(match.fixtureId),
    date,
    kickoff: match.kickoff || null,
    homeTeam: home,
    awayTeam: away,
    score,
    won,
    lost,
    voided,
    options,
    message: [
      ...header.slice(0, 3),
      ...(optionChunks.length > 1 ? [`<i>Parte ${index + 1} de ${optionChunks.length}</i>`, ''] : ['']),
      ...chunk,
      '',
      balance,
    ].join('\n'),
  }));
}
