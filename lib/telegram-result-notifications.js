const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

/**
 * Formatea los estados won/lost que la web ya persistió para las opciones
 * exactas confirmadas por Telegram. Aquí no se liquida ni recalcula nada.
 */
export function buildTelegramMatchResult({ dailyPickId, date, match, outcomes } = {}) {
  if (!dailyPickId || !match?.fixtureId || !Array.isArray(match.options) || !match.options.length) {
    return null;
  }
  const byMarket = new Map((outcomes || []).map(item => [String(item.marketKey), item.outcome]));
  const options = match.options.map(option => ({
    id: String(option.id || ''),
    name: option.name || option.category || option.id || 'Opción',
    status: byMarket.get(String(option.id || '')),
  }));
  if (options.some(option => !['won', 'lost'].includes(option.status))) return null;

  const won = options.filter(option => option.status === 'won').length;
  const lost = options.length - won;
  const home = match.homeTeam || 'Local';
  const away = match.awayTeam || 'Visitante';
  const optionLines = options.map(option => (
    `${option.status === 'won' ? '✅ GANADA' : '❌ PERDIDA'} — ${escapeHtml(option.name)}`
  ));
  const message = [
    '🏁 <b>RESULTADO FINAL</b>',
    '',
    `<b>${escapeHtml(home)} vs ${escapeHtml(away)}</b>`,
    '',
    ...optionLines,
    '',
    `<b>Balance:</b> ${won} ganada${won === 1 ? '' : 's'} · ${lost} perdida${lost === 1 ? '' : 's'}`,
  ].join('\n');

  return {
    combinadaId: dailyPickId,
    fixtureId: Number(match.fixtureId),
    date,
    kickoff: match.kickoff || null,
    homeTeam: home,
    awayTeam: away,
    won,
    lost,
    options,
    message,
  };
}
