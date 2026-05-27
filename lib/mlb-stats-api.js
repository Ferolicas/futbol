// lib/mlb-stats-api.js
//
// Cliente de la MLB Stats API OFICIAL (https://statsapi.mlb.com) — gratuita,
// sin API key. Es la fuente PRINCIPAL de béisbol del proyecto: api-baseball
// (api-sports) no tiene jugadores ni pitchers y su plan free solo da 2022-2024,
// así que para MLB/MiLB usamos esta API que da TODO en tiempo real.
//
// sportId: 1 = MLB · 11 = Triple-A · 12 = Double-A (MiLB).
//
// Endpoints usados:
//   /api/v1/schedule        — juegos del día + probable pitchers + linescore
//   /api/v1/people/{id}      — stats de pitcher (ERA/WHIP/K9) por temporada
//   /api/v1/teams/{id}/stats — stats de equipo (carreras a favor/en contra)
//   /api/v1.1/game/{pk}/feed/live — estado en vivo pitch-by-pitch
//
// Sin key, pero conviene no martillar: las funciones de stats cachean en Redis.

import { redisGet, redisSet } from './redis';

const API = 'https://statsapi.mlb.com/api';

// sportIds soportados (MLB + MiLB AAA/AA). Configurable si se amplía.
export const MLB_SPORT_IDS = { 1: 'MLB', 11: 'Triple-A', 12: 'Double-A' };

// Medias de liga MLB para normalizar el factor del pitcher. Valores típicos
// recientes; se pueden refinar leyéndolos de /api/v1/league pero son estables.
const LEAGUE_AVG_ERA = 4.05;
const LEAGUE_AVG_WHIP = 1.30;
const LEAGUE_AVG_K9 = 8.6;

// Prior de entradas para shrinkage del factor: con pocas IP el factor se acerca
// a 1.0 (neutral), porque 25 IP no son fiables. Con muchas IP refleja al
// pitcher. Misma filosofía que el shrinkage de la calibración.
const IP_PRIOR = 40;

const TTL = {
  pitcher: 12 * 3600,   // stats de pitcher cambian tras cada apertura
  team: 12 * 3600,
  schedule: 600,        // schedule del día — refrescar para probable pitchers
};

async function mlbFetch(path) {
  const url = `${API}${path}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`MLB Stats API ${res.status} en ${path}`);
  return res.json();
}

// Parse "25.2" innings (25 entradas + 2 outs) → 25.667 entradas decimales.
function parseInnings(ip) {
  if (ip == null) return 0;
  const n = Number(ip);
  if (!Number.isFinite(n)) return 0;
  const whole = Math.floor(n);
  const outs = Math.round((n - whole) * 10); // .1 = 1 out, .2 = 2 outs
  return whole + outs / 3;
}

// =====================================================================
// SCHEDULE — juegos del día con probable pitchers y linescore
// =====================================================================
/**
 * Devuelve los juegos de un sportId/fecha en formato normalizado:
 *   { gamePk, dateUTC, status, statusCode, home/away: { id, name, abbreviation,
 *     score, probablePitcherId, probablePitcherName }, inning, isLive, isFinal }
 */
export async function getMlbScheduleByDate(date, sportId = 1) {
  const path = `/v1/schedule?sportId=${sportId}&date=${date}` +
    `&hydrate=probablePitcher,linescore,team`;
  const data = await mlbFetch(path);
  const games = (data.dates?.[0]?.games) || [];
  return games.map(normalizeScheduleGame);
}

function normalizeScheduleGame(g) {
  const h = g.teams?.home || {};
  const a = g.teams?.away || {};
  const ls = g.linescore || {};
  const statusCode = g.status?.statusCode || '';
  const abstract = g.status?.abstractGameState || ''; // Preview | Live | Final
  return {
    gamePk: g.gamePk,
    dateUTC: g.gameDate,
    status: g.status?.detailedState || abstract,
    abstractState: abstract,
    statusCode,
    isLive: abstract === 'Live',
    isFinal: abstract === 'Final',
    inning: ls.currentInning || null,
    inningHalf: ls.inningHalf || null, // Top | Bottom
    home: {
      id: h.team?.id, name: h.team?.name, abbreviation: h.team?.abbreviation,
      score: h.score ?? ls.teams?.home?.runs ?? null,
      probablePitcherId: h.probablePitcher?.id || null,
      probablePitcherName: h.probablePitcher?.fullName || null,
    },
    away: {
      id: a.team?.id, name: a.team?.name, abbreviation: a.team?.abbreviation,
      score: a.score ?? ls.teams?.away?.runs ?? null,
      probablePitcherId: a.probablePitcher?.id || null,
      probablePitcherName: a.probablePitcher?.fullName || null,
    },
  };
}

// =====================================================================
// PITCHER STATS + FACTOR
// =====================================================================
/**
 * Stats de pitcheo de temporada. Si la temporada actual tiene pocas entradas
 * (< IP_PRIOR), MEZCLA con la temporada anterior para tener una muestra fiable
 * (un pitcher en abril con 20 IP no representa su nivel real). Devuelve
 * { era, whip, k9, ip, blended } o null.
 */
export async function getMlbPitcherStats(pitcherId, season) {
  if (!pitcherId) return null;
  const cacheKey = `mlb:pitcher:${pitcherId}:${season}`;
  try {
    const cached = await redisGet(cacheKey);
    if (cached) return cached;
  } catch {}

  const cur = await fetchPitcherSeason(pitcherId, season);
  let out = cur;

  // Blend con temporada anterior si la muestra actual es pequeña.
  if (!cur || cur.ip < IP_PRIOR) {
    const prev = await fetchPitcherSeason(pitcherId, season - 1).catch(() => null);
    if (prev && prev.ip > 0) {
      if (!cur || cur.ip === 0) {
        out = prev;
      } else {
        // Promedio ponderado por IP de ambas temporadas.
        const wTot = cur.ip + prev.ip;
        out = {
          era: (cur.era * cur.ip + prev.era * prev.ip) / wTot,
          whip: (cur.whip * cur.ip + prev.whip * prev.ip) / wTot,
          k9: (cur.k9 * cur.ip + prev.k9 * prev.ip) / wTot,
          ip: cur.ip + prev.ip,
          blended: true,
        };
      }
    }
  }

  if (out) {
    try { await redisSet(cacheKey, out, TTL.pitcher); } catch {}
  }
  return out;
}

async function fetchPitcherSeason(pitcherId, season) {
  const path = `/v1/people/${pitcherId}?hydrate=stats(group=[pitching],type=[season],season=${season})`;
  const data = await mlbFetch(path);
  const splits = data.people?.[0]?.stats?.[0]?.splits || [];
  if (splits.length === 0) return null;
  const s = splits[0].stat || {};
  const ip = parseInnings(s.inningsPitched);
  if (ip <= 0) return null;
  const k = Number(s.strikeOuts) || 0;
  return {
    era: Number(s.era) || LEAGUE_AVG_ERA,
    whip: Number(s.whip) || LEAGUE_AVG_WHIP,
    k9: ip > 0 ? (k * 9) / ip : LEAGUE_AVG_K9,
    ip,
    blended: false,
  };
}

/**
 * Factor multiplicativo de las carreras que el RIVAL anota contra este pitcher.
 *   factor < 1 → pitcher fuerte (rival anota menos)
 *   factor > 1 → pitcher débil (rival anota más)
 *
 * Combina ERA (peso 0.7), WHIP (0.2) y K9 invertido (0.1) normalizados a la
 * media de liga, y aplica SHRINKAGE por IP hacia 1.0 (neutral) para no
 * sobre-confiar en pitchers con pocas entradas. Clamp [0.6, 1.4].
 */
export function computePitcherFactor(stats) {
  if (!stats || !Number.isFinite(stats.era)) return null;
  const eraRatio = stats.era / LEAGUE_AVG_ERA;
  const whipRatio = stats.whip / LEAGUE_AVG_WHIP;
  const k9Ratio = stats.k9 / LEAGUE_AVG_K9;
  // Más K9 → rival anota menos → resta al factor.
  let raw = eraRatio * 0.7 + whipRatio * 0.2 + (1 - (k9Ratio - 1)) * 0.1;
  // shrinkage hacia 1.0 según IP
  const w = stats.ip / (stats.ip + IP_PRIOR);
  const factor = raw * w + 1.0 * (1 - w);
  return Math.max(0.6, Math.min(1.4, Math.round(factor * 1000) / 1000));
}

/**
 * Matchup completo de pitchers para un juego, listo para el modelo:
 *   { home: { name, factor }, away: { name, factor } } o null.
 * `factor` modula las carreras del RIVAL (home.factor afecta runs AWAY).
 */
export async function getMlbPitcherMatchup(game, season) {
  if (!game) return null;
  const [homeStats, awayStats] = await Promise.all([
    getMlbPitcherStats(game.home?.probablePitcherId, season).catch(() => null),
    getMlbPitcherStats(game.away?.probablePitcherId, season).catch(() => null),
  ]);
  const homeFactor = computePitcherFactor(homeStats);
  const awayFactor = computePitcherFactor(awayStats);
  if (homeFactor == null && awayFactor == null) return null;
  return {
    home: { name: game.home?.probablePitcherName || null, factor: homeFactor ?? 1.0, stats: homeStats },
    away: { name: game.away?.probablePitcherName || null, factor: awayFactor ?? 1.0, stats: awayStats },
  };
}

// =====================================================================
// TEAM STATS — carreras a favor / en contra por juego
// =====================================================================
/**
 * Devuelve { games, runsScoredPerGame, runsAllowedPerGame } de la temporada,
 * en el formato que teamStrength() del modelo puede consumir vía adaptador.
 */
export async function getMlbTeamSeasonStats(teamId, season, sportId = 1) {
  if (!teamId) return null;
  const cacheKey = `mlb:team:${teamId}:${season}`;
  try {
    const cached = await redisGet(cacheKey);
    if (cached) return cached;
  } catch {}

  // hitting → runs scored; pitching → runs allowed.
  const path = `/v1/teams/${teamId}/stats?stats=season&group=hitting,pitching&season=${season}&sportId=${sportId}`;
  let data;
  try { data = await mlbFetch(path); } catch { return null; }

  const out = { games: 0, runsScoredPerGame: null, runsAllowedPerGame: null };
  for (const grp of data.stats || []) {
    const split = grp.splits?.[0]?.stat;
    const groupName = grp.group?.displayName || grp.type?.displayName || '';
    if (!split) continue;
    const games = Number(split.gamesPlayed) || 0;
    if (games > out.games) out.games = games;
    if (/hitting/i.test(groupName)) {
      const runs = Number(split.runs) || 0;
      if (games > 0) out.runsScoredPerGame = runs / games;
    } else if (/pitching/i.test(groupName)) {
      const runs = Number(split.runs) || 0; // runs allowed
      if (games > 0) out.runsAllowedPerGame = runs / games;
    }
  }
  if (out.runsScoredPerGame == null && out.runsAllowedPerGame == null) return null;
  try { await redisSet(cacheKey, out, TTL.team); } catch {}
  return out;
}

// Adapta el formato MLB Stats API al que espera teamStrength() del modelo
// (stats.points.for/against.average.total).
export function toModelTeamStats(mlbTeamStats) {
  if (!mlbTeamStats) return null;
  return {
    games: { played: { total: mlbTeamStats.games || 0 } },
    points: {
      for:     { average: { total: mlbTeamStats.runsScoredPerGame ?? null }, total: null },
      against: { average: { total: mlbTeamStats.runsAllowedPerGame ?? null }, total: null },
    },
  };
}

// =====================================================================
// LIVE GAME — estado pitch-by-pitch para la UI en vivo
// =====================================================================
/**
 * Estado en vivo detallado de un juego (para la interfaz tipo bet365):
 * inning, conteo (bolas/strikes/outs), corredores en base, pitcher y bateador
 * actuales, marcador, y línea por entrada.
 */
export async function getMlbLiveGame(gamePk) {
  if (!gamePk) return null;
  const data = await mlbFetch(`/v1.1/game/${gamePk}/feed/live`);
  const ls = data.liveData?.linescore || {};
  const plays = data.liveData?.plays || {};
  const cur = plays.currentPlay || {};
  const offense = ls.offense || {};
  const defense = ls.defense || {};
  const gd = data.gameData || {};

  return {
    gamePk,
    status: gd.status?.detailedState || '',
    abstractState: gd.status?.abstractGameState || '',
    isLive: gd.status?.abstractGameState === 'Live',
    isFinal: gd.status?.abstractGameState === 'Final',
    inning: ls.currentInning || null,
    inningHalf: ls.inningHalf || null,
    inningState: ls.inningState || null,
    outs: ls.outs ?? cur.count?.outs ?? 0,
    balls: cur.count?.balls ?? 0,
    strikes: cur.count?.strikes ?? 0,
    bases: {
      first: !!offense.first,
      second: !!offense.second,
      third: !!offense.third,
    },
    home: {
      name: gd.teams?.home?.name, abbreviation: gd.teams?.home?.abbreviation,
      runs: ls.teams?.home?.runs ?? 0, hits: ls.teams?.home?.hits ?? 0, errors: ls.teams?.home?.errors ?? 0,
    },
    away: {
      name: gd.teams?.away?.name, abbreviation: gd.teams?.away?.abbreviation,
      runs: ls.teams?.away?.runs ?? 0, hits: ls.teams?.away?.hits ?? 0, errors: ls.teams?.away?.errors ?? 0,
    },
    currentPitcher: defense.pitcher ? { id: defense.pitcher.id, name: defense.pitcher.fullName } : null,
    currentBatter: offense.batter ? { id: offense.batter.id, name: offense.batter.fullName } : null,
    lastPlay: cur.result?.description || null,
    innings: (ls.innings || []).map(i => ({
      num: i.num,
      home: i.home?.runs ?? null,
      away: i.away?.runs ?? null,
    })),
  };
}

// =====================================================================
// RESULTS — resultados finalizados de una fecha (para finalize/calibración)
// =====================================================================
/**
 * Resultados finalizados de un sportId/fecha. Devuelve, por juego:
 *   { gamePk, home/away: {name, score}, totalRuns, runDiff, result: 'H'|'A',
 *     innings (para F5), btts }
 */
export async function getMlbResultsByDate(date, sportId = 1) {
  const path = `/v1/schedule?sportId=${sportId}&date=${date}&hydrate=linescore`;
  const data = await mlbFetch(path);
  const games = (data.dates?.[0]?.games) || [];
  return games
    .filter(g => g.status?.abstractGameState === 'Final')
    .map(g => {
      const ls = g.linescore || {};
      const hs = g.teams?.home?.score ?? ls.teams?.home?.runs ?? 0;
      const as = g.teams?.away?.score ?? ls.teams?.away?.runs ?? 0;
      const innings = ls.innings || [];
      // F5 = primeras 5 entradas
      let f5Home = 0, f5Away = 0;
      for (const inn of innings) {
        if (inn.num > 5) break;
        f5Home += inn.home?.runs ?? 0;
        f5Away += inn.away?.runs ?? 0;
      }
      return {
        gamePk: g.gamePk,
        home: { id: g.teams?.home?.team?.id, name: g.teams?.home?.team?.name, score: hs },
        away: { id: g.teams?.away?.team?.id, name: g.teams?.away?.team?.name, score: as },
        totalRuns: hs + as,
        runDiff: hs - as,
        result: hs > as ? 'H' : (as > hs ? 'A' : null),
        btts: hs > 0 && as > 0,
        f5Home, f5Away, f5Total: f5Home + f5Away,
      };
    });
}

// =====================================================================
// PLAYER PROPS — game logs de pitcher y bateador + lineup
//
// MLB Stats API expone el game log (historial partido a partido) de cada
// jugador, con el que calculamos frecuencias reales para los mercados de
// jugador (ponches del pitcher, hits/HR/bases/RBI del bateador). Es lo que
// hace que la app recomiende "cada opción a apostar", no solo mercados de
// equipo. Cacheado (el log cambia tras cada juego del jugador).
// =====================================================================
const TTL_PLAYERLOG = 6 * 3600;

// Game log de pitcher → array de ponches por juego (más reciente al final).
export async function getMlbPitcherGameLog(pitcherId, season) {
  if (!pitcherId) return null;
  const ck = `mlb:plog:p:${pitcherId}:${season}`;
  try { const c = await redisGet(ck); if (c) return c; } catch {}
  let data;
  try { data = await mlbFetch(`/v1/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${season}`); }
  catch { return null; }
  const splits = data.stats?.[0]?.splits || [];
  const history = splits.map(s => Number(s.stat?.strikeOuts) || 0);
  try { await redisSet(ck, history, TTL_PLAYERLOG); } catch {}
  return history;
}

// Game log de bateador → {hits, homeRuns, totalBases, rbi} por juego.
export async function getMlbBatterGameLog(batterId, season) {
  if (!batterId) return null;
  const ck = `mlb:plog:b:${batterId}:${season}`;
  try { const c = await redisGet(ck); if (c) return c; } catch {}
  let data;
  try { data = await mlbFetch(`/v1/people/${batterId}/stats?stats=gameLog&group=hitting&season=${season}`); }
  catch { return null; }
  const splits = data.stats?.[0]?.splits || [];
  const history = {
    hits:       splits.map(s => Number(s.stat?.hits) || 0),
    homeRuns:   splits.map(s => Number(s.stat?.homeRuns) || 0),
    totalBases: splits.map(s => Number(s.stat?.totalBases) || 0),
    rbi:        splits.map(s => Number(s.stat?.rbi) || 0),
  };
  try { await redisSet(ck, history, TTL_PLAYERLOG); } catch {}
  return history;
}

// Lineup confirmado de un juego (battingOrder) con nombres. Vacío si MLB aún
// no publicó la alineación (se confirma ~horas antes del partido).
export async function getMlbGameLineup(gamePk) {
  if (!gamePk) return { home: [], away: [] };
  let data;
  try { data = await mlbFetch(`/v1/game/${gamePk}/boxscore`); } catch { return { home: [], away: [] }; }
  const side = (s) => {
    const t = data.teams?.[s];
    const order = t?.battingOrder || [];
    return order.map(pid => ({ id: pid, name: t.players?.[`ID${pid}`]?.person?.fullName || null })).filter(x => x.name);
  };
  return { home: side('home'), away: side('away') };
}

/**
 * Construye los playerHighlights que consume el modelo (buildBaseballPlayer
 * probabilities): { strikeouts:[{id,name,teamName,history,total}], hits:[...],
 * homeRuns:[...], totalBases:[...], rbis:[...] }.
 *
 *  - Pitchers abridores (home/away): SIEMPRE (ya tenemos su id) → ponches.
 *  - Bateadores: solo si MLB ya publicó el lineup confirmado del juego.
 */
export async function extractBaseballPlayerHighlights(game, season) {
  if (!game) return null;
  const out = { strikeouts: [], hits: [], homeRuns: [], totalBases: [], rbis: [] };

  // Ponches de los pitchers abridores.
  const pitchers = [
    { id: game.home?.probablePitcherId, name: game.home?.probablePitcherName, team: game.home?.name },
    { id: game.away?.probablePitcherId, name: game.away?.probablePitcherName, team: game.away?.name },
  ];
  await Promise.all(pitchers.map(async (p) => {
    if (!p.id) return;
    const log = await getMlbPitcherGameLog(p.id, season).catch(() => null);
    if (log && log.length >= 3) {
      out.strikeouts.push({ id: p.id, name: p.name, teamName: p.team, history: log, total: log.reduce((a, b) => a + b, 0) });
    }
  }));

  // Props de bateadores del lineup confirmado (si está publicado).
  const lineup = await getMlbGameLineup(game.gamePk).catch(() => ({ home: [], away: [] }));
  const batters = [
    ...lineup.home.map(b => ({ ...b, team: game.home?.name })),
    ...lineup.away.map(b => ({ ...b, team: game.away?.name })),
  ];
  await Promise.all(batters.map(async (b) => {
    const log = await getMlbBatterGameLog(b.id, season).catch(() => null);
    if (!log || (log.hits || []).length < 5) return;
    const base = { id: b.id, name: b.name, teamName: b.team };
    out.hits.push({ ...base, history: log.hits });
    out.homeRuns.push({ ...base, history: log.homeRuns });
    out.totalBases.push({ ...base, history: log.totalBases });
    out.rbis.push({ ...base, history: log.rbi });
  }));

  return (out.strikeouts.length || out.hits.length) ? out : null;
}
