import { pgPool } from './db';
import { freeAnalysis } from './free-access';

export async function freeFootballList(data, fixtures = [], liveStats = {}) {
  const ids = Object.keys(data).filter(id => /^\d+$/.test(id));
  if (!ids.length) return {};
  const { rows } = await pgPool.query('SELECT fixture_id, analysis, combinada, live_stats FROM match_analysis WHERE fixture_id = ANY($1::bigint[])', [ids]);
  const canonical = new Map(rows.map(row => [String(row.fixture_id), row]));
  const games = new Map(fixtures.map(game => [String(game?.fixture?.id), game]));
  return Object.fromEntries(ids.map(id => {
    const row = canonical.get(id);
    return [id, freeAnalysis({ ...(row || data[id]), combinada: data[id]?.combinada || { selectable: [] } }, 'football', {
      game: games.get(id),
      liveResult: liveStats[id] || row?.live_stats || null,
    })];
  }));
}
