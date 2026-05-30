/**
 * GET /api/baseball/standings/[league]
 *
 * Standings MLB desde la MLB Stats API oficial (statsapi.mlb.com — gratuita).
 * El parámetro `league` se interpreta como ID interno de la app: 1 = MLB.
 * Internamente la MLB Stats API distingue 103 (AL) y 104 (NL); cuando piden
 * MLB devolvemos ambas ligas, unificadas. Para no romper el contrato JSON que
 * el dashboard espera, conservamos: { leagueId, standings, fromCache }.
 */
import { redisGet, redisSet } from '../../../../../lib/redis';

export const dynamic = 'force-dynamic';

const STATS_API = 'https://statsapi.mlb.com/api';
const TTL = 24 * 3600;

// Logo oficial del equipo por id.
const mlbLogo = (teamId) => teamId ? `https://www.mlbstatic.com/team-logos/${teamId}.svg` : null;

function currentSeason() {
  // MLB season = año calendario; tras World Series se sigue mostrando el último.
  const d = new Date();
  return d.getMonth() >= 10 ? d.getFullYear() : d.getFullYear();
}

async function fetchMlbStandings(leagueId, season) {
  const url = `${STATS_API}/v1/standings?leagueId=${leagueId}&season=${season}&standingsTypes=regularSeason`;
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`MLB Stats API ${res.status}`);
  const data = await res.json();
  return data.records || [];
}

// Records de MLB Stats API → array tipo api-sports: { position, team, group, won, lost, percentage, gamesBack }
function normalizeRecords(records) {
  const out = [];
  for (const rec of records) {
    const divisionName = rec.division?.name || rec.division?.id || '';
    for (const tr of rec.teamRecords || []) {
      out.push({
        position: tr.divisionRank ? Number(tr.divisionRank) : null,
        group: { name: divisionName },
        team: {
          id: tr.team?.id,
          name: tr.team?.name,
          logo: mlbLogo(tr.team?.id),
        },
        games: { played: tr.gamesPlayed ?? null },
        won: tr.wins ?? null,
        lost: tr.losses ?? null,
        percentage: tr.winningPercentage ?? null,
        gamesBack: tr.gamesBack ?? null,
        form: tr.records?.splitRecords?.find(s => s.type === 'lastTen')
          ? `L10 ${tr.records.splitRecords.find(s => s.type === 'lastTen').wins}-${tr.records.splitRecords.find(s => s.type === 'lastTen').losses}`
          : null,
        streak: tr.streak?.streakCode || null,
      });
    }
  }
  return out;
}

export async function GET(_request, { params }) {
  try {
    const leagueId = Number(params.league);
    if (!leagueId) return Response.json({ error: 'Invalid league id' }, { status: 400 });
    if (leagueId !== 1) {
      // Solo MLB tras la migración (las ligas de api-sports ya no se atienden).
      return Response.json({ leagueId, standings: [], fromCache: false, error: 'Only MLB (id=1) supported after MLB-only migration' });
    }

    const season = currentSeason();
    const cacheKey = `mlb:standings:${season}`;
    try {
      const cached = await redisGet(cacheKey);
      if (cached) return Response.json({ leagueId, standings: cached, fromCache: true });
    } catch {}

    // AL (103) + NL (104) en paralelo.
    const [al, nl] = await Promise.all([
      fetchMlbStandings(103, season).catch(() => []),
      fetchMlbStandings(104, season).catch(() => []),
    ]);

    // Shape compatible con api-sports: array con una entrada por liga, cuyo
    // campo `standings` contiene un array de grupos (divisiones) — pero el
    // frontend baseball no consume este endpoint, así que entregamos un shape
    // más plano y útil: una sola entrada con todos los equipos agrupados por
    // división dentro del campo `groups`.
    const standings = [{
      league: { id: 1, name: 'MLB', season },
      groups: [
        ...al.map(r => ({ id: 'AL', name: r.division?.name || 'AL', records: normalizeRecords([r]) })),
        ...nl.map(r => ({ id: 'NL', name: r.division?.name || 'NL', records: normalizeRecords([r]) })),
      ],
    }];

    try { await redisSet(cacheKey, standings, TTL); } catch {}
    return Response.json({ leagueId, standings, fromCache: false });
  } catch (e) {
    console.error('[api/baseball/standings]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
