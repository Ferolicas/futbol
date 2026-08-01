// @ts-nocheck
import { prepareSportDate, bogotaToday, triggerEvent, supabaseAdmin } from '../../shared.js';

async function withinGameWindow(sport, date) {
  const prefix = sport === 'basketball' ? 'basketball' : 'american_football';
  const { data } = await supabaseAdmin
    .from(`${prefix}_match_schedule`).select('schedule').eq('date', date).maybeSingle();
  const now = Date.now();
  return (data?.schedule?.kickoffTimes || []).some((game) => now >= Number(game.kickoff) - 30 * 60_000 && now <= Number(game.expectedEnd) + 60 * 60_000);
}

async function run(sport, payload) {
  const date = payload.date || bogotaToday();
  if (!(await withinGameWindow(sport, date))) return { ok: true, sport, skipped: 'outside-game-window' };
  const report = await prepareSportDate(sport, date, { ttl: sport === 'basketball' ? 540 : 240 });
  const games = report.games.filter((game) => game.status?.isLive || game.status?.isFinal).map((game) => ({
    id: game.id, providerFixtureId: game.providerFixtureId, status: game.status,
    home: { id: game.teams.home.id, score: game.scores.home.total },
    away: { id: game.teams.away.id, score: game.scores.away.total }, periods: game.periods,
  }));
  if (games.length) await triggerEvent(`${sport}-live`, 'update', { date, games, at: new Date().toISOString() });
  return { ok: true, sport, games: games.length };
}

export const runBasketballLive = (payload = {}) => run('basketball', payload);
export const runAmericanFootballLive = (payload = {}) => run('american_football', payload);
