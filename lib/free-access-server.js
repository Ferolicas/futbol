import { pgPool } from './db';
import { freeAnalysis } from './free-access';

export async function freeFootballList(data) {
  const ids = Object.keys(data).filter(id => /^\d+$/.test(id));
  if (!ids.length) return {};
  const { rows } = await pgPool.query('SELECT fixture_id, analysis, combinada FROM match_analysis WHERE fixture_id = ANY($1::bigint[])', [ids]);
  const canonical = new Map(rows.map(row => [String(row.fixture_id), row]));
  return Object.fromEntries(ids.map(id => [id, freeAnalysis({ ...(canonical.get(id) || data[id]), combinada: data[id]?.combinada || { selectable: [] } })]));
}
