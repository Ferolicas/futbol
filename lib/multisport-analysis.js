import { pgPool } from './db.js';
import { getMultisportConfig, getSportCompetition, getSportCompetitions, isIsoDate } from './multisport-config.js';
import { getSportGameDetails, getSportGamesByDate, getSportOdds } from './multisport-providers.js';
import {
  buildEmpiricalPlayerProbabilities,
  computeMultisportEmpiricalPrediction,
  invertEmpiricalEvidence,
  toBaseballProbabilityShape,
} from './multisport-empirical-engine.js';
import {
  getSportAnalyses,
  ingestFinalSportGame,
  persistSportGames,
  persistSportSchedule,
  saveSportAnalysis,
  saveSportPrediction,
} from './multisport-store.js';
import { extractBaseballPlayerHighlights, getMlbPitcherMatchup } from './mlb-stats-api.js';
import {
  BASEBALL_RECOMMENDATION_MIN_PROBABILITY,
  BASEBALL_DAILY_MIN_PROBABILITY,
  BASEBALL_DAILY_MIN_RELIABILITY,
  meetsReliability,
} from './recommendation-policy.js';
import { entryReliabilityPercent, evidenceSample } from './reliability.js';
import { buildMultisportFinalVerdict } from './final-verdict.js';

const CACHE_VERSION = 20; // política Baseball en NBA/NCAA/NFL + veredicto final aislado
const BOGOTA_TIME_ZONE = 'America/Bogota';
const BASEBALL_ODDS_REFRESH_START_MINUTES = 10 * 60 + 30;
const BASEBALL_ODDS_RETRY_MIN_AGE_MS = 12 * 60_000;

// Ventana de reintento de cuotas. API-Baseball va en plan Free (100 req/día) y
// cada partido sin cuota gasta una llamada por tick. Pedirlas doce horas antes
// del primer lanzamiento agota el presupuesto mucho antes de que Bet365 fije la
// línea que el cliente verá. Solo se reintenta dentro de esta antesala.
const BASEBALL_ODDS_RETRY_WINDOW_MS = 8 * 3600_000;

// Tope de partidos que un mismo pase puede reintentar. Evita que una jornada
// con doble cartelera queme la cuota diaria entera en un solo tick.
const BASEBALL_ODDS_RETRY_MAX_PER_RUN = 8;
// NBA/NCAA y NFL/NCAA comparten la politica publica de Baseball: una opcion
// calculada entra desde 65%, siempre que la linea exacta exista en Bet365 y la
// cuota sea al menos 1,20. La fiabilidad sigue visible como evidencia, pero no
// es un veto adicional para este catalogo (igual que en Baseball).
const MULTISPORT_MIN_PROBABILITY = BASEBALL_RECOMMENDATION_MIN_PROBABILITY;

// Techos de tiempo. El 5 de agosto de 2026 un pase de coverage se quedó
// esperando una promesa que nunca resolvió: 31 h en `active`, renovando el lock
// (BullMQ no lo declaró stalled) y bloqueando la cola entera con concurrency=1.
// Ningún partido puede tardar minutos y ninguna jornada puede tardar una hora,
// así que ambos niveles se cortan solos y el resto sigue.
const SPORT_GAME_TIMEOUT_MS = 3 * 60_000;
const SPORT_DATE_TIMEOUT_MS = 20 * 60_000;

/**
 * Corre `promise` con un techo de tiempo. Rechaza con un error identificable si
 * se agota, para que el llamador lo cuente como fallo del partido/jornada en
 * vez de quedarse colgado indefinidamente.
 */
export function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Tiempo agotado (${Math.round(ms / 1000)}s) en ${label}`);
      error.code = 'TIMEOUT';
      reject(error);
    }, ms);
    if (typeof timer?.unref === 'function') timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

function shiftIsoDate(date, amount) {
  if (!isIsoDate(date)) throw new Error(`Fecha inválida: ${date}`);
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

// Una fecha local puede reunir juegos de dos jornadas del proveedor. El
// reconciliador cubre también los días adyacentes para que cambiar de zona
// horaria nunca convierta una tarjeta válida en una acción manual de análisis.
export function buildSportAnalysisCoverageDates(date) {
  return [-1, 0, 1].map((offset) => shiftIsoDate(date, offset));
}

function zonedDateAndMinutes(value, timeZone = BOGOTA_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function shouldRetryMissingBaseballOdds(game, analysis, options = {}) {
  if (!analysis || analysis?.data_quality?.hasOdds === true) return false;
  if (game?.status?.isFinal || game?.status?.isLive) return false;

  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const kickoff = new Date(game?.date);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(kickoff.getTime()) || kickoff <= now) return false;

  // Fuera de la antesala no se gasta cuota: la línea de Bet365 de dentro de
  // doce horas no es la que el cliente va a encontrar cuando apueste.
  const windowMs = Number(options.retryWindowMs ?? BASEBALL_ODDS_RETRY_WINDOW_MS);
  if (kickoff.getTime() - now.getTime() > windowMs) return false;

  const timeZone = options.timeZone || BOGOTA_TIME_ZONE;
  const current = zonedDateAndMinutes(now, timeZone);
  const gameTime = zonedDateAndMinutes(kickoff, timeZone);
  if (!current || !gameTime || current.date !== gameTime.date) return false;

  const refreshStartMinutes = Number(options.refreshStartMinutes ?? BASEBALL_ODDS_REFRESH_START_MINUTES);
  if (current.minutes < refreshStartMinutes) return false;

  const updatedAt = new Date(analysis.updated_at).getTime();
  const minAgeMs = Number(options.minAgeMs ?? BASEBALL_ODDS_RETRY_MIN_AGE_MS);
  return !Number.isFinite(updatedAt) || now.getTime() - updatedAt >= minAgeMs;
}

export function selectGamesNeedingCurrentAnalysis(games, analyses, cacheVersion = CACHE_VERSION, options = {}) {
  const byFixture = new Map((analyses || []).map((analysis) => [String(analysis.fixture_id), analysis]));
  const stale = [];
  const oddsRetries = [];
  for (const game of games || []) {
    const analysis = byFixture.get(String(game.id));
    if (!analysis || Number(analysis.cache_version || 0) < cacheVersion) { stale.push(game); continue; }
    if (options.retryMissingOdds === true && shouldRetryMissingBaseballOdds(game, analysis, options)) {
      oddsRetries.push(game);
    }
  }
  // Los reintentos de cuota compiten por un presupuesto diario de 100 llamadas.
  // Se atienden primero los partidos más cercanos al primer lanzamiento, que
  // son los que el cliente está a punto de apostar, y se corta ahí.
  const maxRetries = Number(options.maxOddsRetries ?? BASEBALL_ODDS_RETRY_MAX_PER_RUN);
  oddsRetries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return [...stale, ...oddsRetries.slice(0, Math.max(0, maxRetries))];
}

function lineKey(value) {
  return String(value).replace('-', 'm').replace('.', '_');
}

function oddValue(entry) {
  if (entry == null) return null;
  const value = Number(typeof entry === 'object' ? entry.odd : entry);
  return Number.isFinite(value) && value >= 1.2 ? value : null;
}

function normalizedBookmaker(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function oddMetadata(entry) {
  if (!entry || typeof entry !== 'object') return {};
  return {
    bookmaker: entry.bookmaker || null,
    bookmakerId: entry.bookmakerId ?? null,
    bookmakerMarketId: entry.marketId ?? null,
    bookmakerMarket: entry.marketName || null,
    bookmakerSelection: entry.selectionName || null,
  };
}

function signedLine(value) {
  const line = Number(value);
  return Number.isFinite(line) && line > 0 ? `+${line}` : String(value);
}

function probabilityValue(entry) {
  const value = Number(entry?.probability ?? entry);
  return Number.isFinite(value) ? value : null;
}

// Muestra y fiabilidad de una entrada del motor. Los mercados de jugador
// envuelven su evidencia un nivel más adentro que los de equipo.
function sampleEvidence(entry, thresholdPercent) {
  const evidence = entry?.evidence ?? null;
  const sample = evidenceSample(evidence);
  return {
    sampleN: sample?.n ?? null,
    sampleHits: sample?.hits ?? null,
    reliability: entryReliabilityPercent(entry, thresholdPercent),
  };
}

function rawProbabilityValue(entry) {
  const raw = entry?.rawProbability == null ? null : Number(entry.rawProbability);
  if (raw != null && Number.isFinite(raw)) return raw * 100;
  return probabilityValue(entry);
}

function normalizedPersonName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

const BASEBALL_PLAYER_MARKET_LABELS = Object.freeze({
  hits: 'Hits del bateador',
  homeRuns: 'Jonrones del bateador',
  totalBases: 'Bases totales del bateador',
  rbis: 'Carreras impulsadas del bateador',
  runs: 'Carreras anotadas del bateador',
  walks: 'Bases por bolas del bateador',
  stolenBases: 'Bases robadas del bateador',
  strikeouts: 'Ponches del lanzador',
  battingStrikeouts: 'Ponches del bateador',
});

function playerProbability(player, line, side) {
  const direct = player?.lineSides?.[line]?.[side];
  if (direct) return direct;
  const over = Number(player?.evidence?.[line]?.rawProbability);
  if (!Number.isFinite(over)) return null;
  const rawProbability = side === 'under' ? 1 - over : over;
  // La evidencia guardada cuenta los aciertos del OVER. Para el UNDER hay que
  // invertirla: si no, la fiabilidad del "menos de" se calcularía con los
  // aciertos del "más de" y saldría justo al revés.
  const source = player.evidence[line];
  const evidence = side === 'under' ? invertEmpiricalEvidence(source) : source;
  return {
    probability: rawProbability >= .95 ? 95 : Math.floor((rawProbability * 100 + 1e-9) * 100) / 100,
    rawProbability,
    evidence,
  };
}

export function buildMultisportCombinada(prediction, odds, game, options = {}) {
  const config = getMultisportConfig(prediction.sport);
  const isBaseball = config.key === 'baseball';
  const selectableThreshold = options.selectableThreshold ?? MULTISPORT_MIN_PROBABILITY;
  const highlightThreshold = options.highlightThreshold ?? MULTISPORT_MIN_PROBABILITY;
  // Umbral contra el que se mide la fiabilidad: el de la Apuesta del Día, que es
  // el listón que la selección tendrá que superar para publicarse.
  const reliabilityThreshold = options.reliabilityThreshold ?? BASEBALL_DAILY_MIN_PROBABILITY;
  const minimumReliability = options.minimumReliability ?? null;
  const candidates = [];
  const add = ({ id, category, marketLabel, name, probability, odd, validationKey, scope = 'match', line = null, side = null }) => {
    const p = probabilityValue(probability);
    const rawProbability = rawProbabilityValue(probability);
    const o = oddValue(odd);
    const passesProbability = rawProbability >= selectableThreshold;
    if (p == null || rawProbability == null || !o || !passesProbability) return;
    const metadata = oddMetadata(odd);
    // Defensa adicional al filtro del proveedor: una fila antigua, un payload
    // manual o una configuración global nunca puede colar otra casa en Baseball.
    if (isBaseball && normalizedBookmaker(metadata.bookmaker) !== 'bet365') return;
    if (!isBaseball && normalizedBookmaker(metadata.bookmaker) !== 'bet365') return;
    const evidence = sampleEvidence(probability, reliabilityThreshold);
    if (minimumReliability != null && !meetsReliability(evidence.reliability, minimumReliability)) return;
    candidates.push({
      id,
      category,
      market: marketLabel || category,
      marketLabel: marketLabel || category,
      name,
      pick: name,
      probability: p,
      rawProbability,
      odd: o,
      validationKey,
      scope,
      line,
      side,
      // Fiabilidad = P(la tasa real ≥ umbral diario | muestra observada). Sin
      // esto, "80%" sobre cinco partidos y "80%" sobre quinientos entraban en
      // la Apuesta del Día con el mismo peso.
      ...evidence,
      ...metadata,
      statisticalRecommendation: true,
    });
  };

  add({ id: 'ml-home', category: 'moneyline', marketLabel: 'Ganador del partido', name: `${game.teams.home.name} gana`, probability: prediction.moneyline?.home, odd: odds?.moneyline?.home, validationKey: 'moneyline_home', side: 'home' });
  add({ id: 'ml-away', category: 'moneyline', marketLabel: 'Ganador del partido', name: `${game.teams.away.name} gana`, probability: prediction.moneyline?.away, odd: odds?.moneyline?.away, validationKey: 'moneyline_away', side: 'away' });
  if (config.drawAllowed) add({ id: 'ml-draw', category: 'moneyline', marketLabel: 'Ganador del partido', name: 'Empate', probability: prediction.moneyline?.draw, odd: odds?.moneyline?.draw, validationKey: 'moneyline_draw', side: 'draw' });

  for (const [line, values] of Object.entries(prediction.totals?.lines || {})) {
    add({ id: `total-${line}-over`, category: `total-${line}`, marketLabel: `Total de ${config.scoreLabel}`, name: `Más de ${line} ${config.scoreLabel}`, probability: values.over, odd: odds?.totals?.[line]?.over, validationKey: `total_over_${lineKey(line)}`, line: Number(line), side: 'over' });
    add({ id: `total-${line}-under`, category: `total-${line}`, marketLabel: `Total de ${config.scoreLabel}`, name: `Menos de ${line} ${config.scoreLabel}`, probability: values.under, odd: odds?.totals?.[line]?.under, validationKey: `total_under_${lineKey(line)}`, line: Number(line), side: 'under' });
  }

  if (!isBaseball) {
    for (const team of ['home', 'away']) {
      for (const [line, probability] of Object.entries(prediction.spreads?.[team] || {})) {
        add({
          id: `handicap-${team}-${lineKey(line)}`,
          category: `handicap-${line}`,
          marketLabel: 'Hándicap',
          name: `${game.teams[team].name} ${signedLine(line)}`,
          probability,
          odd: odds?.spreads?.[team]?.[line],
          validationKey: `spread_${team}_${lineKey(line)}`,
          line: Number(line), side: team,
        });
      }
      for (const [line, values] of Object.entries(prediction.teamTotals?.[team] || {})) {
        for (const side of ['over', 'under']) add({
          id: `team-total-${team}-${line}-${side}`,
          category: `team-total-${team}-${line}`,
          marketLabel: `Total de ${config.scoreLabel} de ${game.teams[team].name}`,
          name: `${game.teams[team].name}: ${side === 'over' ? 'más' : 'menos'} de ${line} ${config.scoreLabel}`,
          probability: values?.[side],
          odd: odds?.teamTotals?.[team]?.[line]?.[side],
          validationKey: `team_total_${team}_${side}_${lineKey(line)}`,
          scope: 'team', line: Number(line), side,
        });
      }
    }

    for (const [periodKey, periodPrediction] of Object.entries(prediction.periods || {})) {
      const periodOdds = odds?.periods?.[periodKey];
      if (!periodOdds) continue;
      const periodLabel = periodOdds.label || periodPrediction.label || periodKey;
      for (const [line, values] of Object.entries(periodPrediction.totals || {})) {
        for (const side of ['over', 'under']) add({
          id: `${periodKey}-total-${line}-${side}`,
          category: `${periodKey}-total-${line}`,
          marketLabel: `Total (${periodLabel})`,
          name: `${side === 'over' ? 'Más' : 'Menos'} de ${line} ${config.scoreLabel} en ${periodLabel}`,
          probability: values?.[side], odd: periodOdds.totals?.[line]?.[side],
          validationKey: `${periodKey}_total_${side}_${lineKey(line)}`,
          line: Number(line), side,
        });
      }
      for (const team of ['home', 'away']) {
        add({
          id: `${periodKey}-moneyline-${team}`, category: `${periodKey}-moneyline`,
          marketLabel: `Ganador (${periodLabel})`, name: `${game.teams[team].name} gana en ${periodLabel}`,
          probability: periodPrediction.moneyline?.[team], odd: periodOdds.moneyline?.[team],
          validationKey: `${periodKey}_moneyline_${team}`, side: team,
        });
        for (const [line, probability] of Object.entries(periodPrediction.spreads?.[team] || {})) add({
          id: `${periodKey}-handicap-${team}-${lineKey(line)}`,
          category: `${periodKey}-handicap-${line}`,
          marketLabel: `Hándicap (${periodLabel})`,
          name: `${game.teams[team].name} ${signedLine(line)} en ${periodLabel}`,
          probability, odd: periodOdds.spreads?.[team]?.[line],
          validationKey: `${periodKey}_spread_${team}_${lineKey(line)}`,
          line: Number(line), side: team,
        });
        for (const [line, values] of Object.entries(periodPrediction.teamTotals?.[team] || {})) {
          for (const side of ['over', 'under']) add({
            id: `${periodKey}-team-total-${team}-${line}-${side}`,
            category: `${periodKey}-team-total-${team}-${line}`,
            marketLabel: `${game.teams[team].name} (${periodLabel})`,
            name: `${game.teams[team].name}: ${side === 'over' ? 'más' : 'menos'} de ${line} ${config.scoreLabel} en ${periodLabel}`,
            probability: values?.[side], odd: periodOdds.teamTotals?.[team]?.[line]?.[side],
            validationKey: `${periodKey}_team_total_${team}_${side}_${lineKey(line)}`,
            scope: 'team', line: Number(line), side,
          });
        }
      }
      add({
        id: `${periodKey}-moneyline-draw`, category: `${periodKey}-moneyline`,
        marketLabel: `Ganador (${periodLabel})`, name: `Empate en ${periodLabel}`,
        probability: periodPrediction.moneyline?.draw, odd: periodOdds.moneyline?.draw,
        validationKey: `${periodKey}_moneyline_draw`, side: 'draw',
      });
    }
  }

  if (isBaseball) {
    const spreadProbabilities = prediction.spreads || {
      home: { [-1.5]: prediction.spread?.homeMinus, [1.5]: prediction.spread?.homePlus },
      away: { [-1.5]: prediction.spread?.awayMinus, [1.5]: prediction.spread?.awayPlus },
    };
    for (const team of ['home', 'away']) {
      for (const [line, probability] of Object.entries(spreadProbabilities[team] || {})) {
        const numericLine = Number(line);
        add({
          id: `handicap-${team}-${lineKey(line)}`,
          category: `handicap-${line}`,
          marketLabel: 'Hándicap asiático',
          name: `${game.teams[team].name} ${signedLine(line)}`,
          probability,
          odd: odds?.spreads?.[team]?.[line],
          validationKey: `spread_${team}_${lineKey(line)}`,
          line: numericLine,
          side: team,
        });
      }
    }

    const periodPredictions = prediction.periods || { first5: prediction.period };
    for (const [periodKey, periodPrediction] of Object.entries(periodPredictions)) {
      const periodOdds = odds?.periods?.[periodKey];
      if (!periodPrediction || !periodOdds) continue;
      const periodLabel = periodOdds.label || periodPrediction.label || periodKey;
      for (const [line, values] of Object.entries(periodPrediction.totals || {})) {
        for (const side of ['over', 'under']) {
          add({
            id: `${periodKey}-total-${line}-${side}`,
            category: `${periodKey}-total-${line}`,
            marketLabel: `Total de carreras (${periodLabel})`,
            name: `${side === 'over' ? 'Más' : 'Menos'} de ${line} carreras en ${periodLabel}`,
            probability: values[side],
            odd: periodOdds.totals?.[line]?.[side],
            validationKey: `${periodKey}_total_${side}_${lineKey(line)}`,
            line: Number(line), side,
          });
        }
      }
      for (const team of ['home', 'away']) {
        const teamProbability = periodPrediction.moneyline?.[team];
        add({
          id: `${periodKey}-moneyline-${team}`,
          category: `${periodKey}-moneyline`,
          marketLabel: `Ganador (${periodLabel})`,
          name: `${game.teams[team].name} gana en ${periodLabel}`,
          probability: teamProbability,
          odd: periodOdds.moneyline?.[team],
          validationKey: `${periodKey}_moneyline_${team}`,
          side: team,
        });
      }
      add({
        id: `${periodKey}-moneyline-draw`, category: `${periodKey}-moneyline`,
        marketLabel: `Ganador (${periodLabel})`, name: `Empate en ${periodLabel}`,
        probability: periodPrediction.moneyline?.draw, odd: periodOdds.moneyline?.draw,
        validationKey: `${periodKey}_moneyline_draw`, side: 'draw',
      });
      for (const team of ['home', 'away']) {
        for (const [line, probability] of Object.entries(periodPrediction.spreads?.[team] || {})) {
          add({
            id: `${periodKey}-handicap-${team}-${lineKey(line)}`,
            category: `${periodKey}-handicap-${line}`,
            marketLabel: `Hándicap asiático (${periodLabel})`,
            name: `${game.teams[team].name} ${signedLine(line)} en ${periodLabel}`,
            probability,
            odd: periodOdds.spreads?.[team]?.[line],
            validationKey: `${periodKey}_spread_${team}_${lineKey(line)}`,
            line: Number(line), side: team,
          });
        }
        for (const [line, values] of Object.entries(periodPrediction.teamTotals?.[team] || {})) {
          for (const side of ['over', 'under']) {
            add({
              id: `${periodKey}-team-total-${team}-${line}-${side}`,
              category: `${periodKey}-team-total-${team}-${line}`,
              marketLabel: `Carreras de ${game.teams[team].name} (${periodLabel})`,
              name: `${game.teams[team].name}: ${side === 'over' ? 'más' : 'menos'} de ${line} carreras en ${periodLabel}`,
              probability: values[side],
              odd: periodOdds.teamTotals?.[team]?.[line]?.[side],
              validationKey: `${periodKey}_team_total_${team}_${side}_${lineKey(line)}`,
              scope: 'team', line: Number(line), side,
            });
          }
        }
      }
      for (const outcome of ['yes', 'no']) {
        add({
          id: `${periodKey}-run-${outcome}`, category: `${periodKey}-run`,
          marketLabel: `¿Habrá carrera? (${periodLabel})`,
          name: `${outcome === 'yes' ? 'Sí' : 'No'} habrá carrera en ${periodLabel}`,
          probability: periodPrediction.run?.[outcome],
          odd: periodOdds.specials?.[`run_${outcome}`],
          validationKey: `${periodKey}_run_${outcome}`, side: outcome,
        });
      }
    }

    for (const team of ['home', 'away']) {
      const teamName = game.teams[team].name;
      for (const [line, values] of Object.entries(prediction.teamTotals?.[team] || {})) {
        add({ id: `team-total-${team}-${line}-over`, category: `team-total-${team}-${line}`, marketLabel: `Total de carreras de ${teamName}`, name: `${teamName}: más de ${line} carreras`, probability: values.over, odd: odds?.teamTotals?.[team]?.[line]?.over, validationKey: `team_total_${team}_over_${lineKey(line)}`, scope: 'team', line: Number(line), side: 'over' });
        add({ id: `team-total-${team}-${line}-under`, category: `team-total-${team}-${line}`, marketLabel: `Total de carreras de ${teamName}`, name: `${teamName}: menos de ${line} carreras`, probability: values.under, odd: odds?.teamTotals?.[team]?.[line]?.under, validationKey: `team_total_${team}_under_${lineKey(line)}`, scope: 'team', line: Number(line), side: 'under' });
      }
    }

    for (const [metric, scopes] of Object.entries(prediction.statistics || {})) {
      const metricOdds = odds?.statistics?.[metric];
      if (!metricOdds) continue;
      for (const scope of ['total', 'home', 'away']) {
        const scopeName = scope === 'total' ? 'ambos equipos' : game.teams[scope].name;
        for (const [line, values] of Object.entries(scopes?.[scope] || {})) {
          for (const side of ['over', 'under']) {
            add({
              id: `stat-${metric}-${scope}-${line}-${side}`,
              category: `stat-${metric}-${scope}-${line}`,
              marketLabel: `${scopes.label || metric} de ${scopeName}`,
              name: `${scopeName}: ${side === 'over' ? 'más' : 'menos'} de ${line} ${scopes.label || metric}`,
              probability: values[side], odd: metricOdds?.[scope]?.[line]?.[side],
              validationKey: `stat_${metric}_${scope}_${side}_${lineKey(line)}`,
              scope, line: Number(line), side,
            });
          }
        }
      }
    }

    const specialOdds = odds?.specials || {};
    const specialPrediction = prediction.specials || {};
    for (const outcome of ['odd', 'even']) {
      add({
        id: `special-total-parity-${outcome}`, category: 'special-total-parity',
        marketLabel: 'Paridad de carreras del partido',
        name: `Total de carreras ${outcome === 'odd' ? 'impar' : 'par'}`,
        probability: specialPrediction.totalParity?.[outcome], odd: specialOdds.totalParity?.[outcome],
        validationKey: `total_parity_${outcome}`, side: outcome,
      });
    }
    for (const team of ['home', 'away']) {
      for (const outcome of ['odd', 'even']) {
        add({
          id: `special-team-parity-${team}-${outcome}`, category: `special-team-parity-${team}`,
          marketLabel: `Paridad de carreras de ${game.teams[team].name}`,
          name: `${game.teams[team].name}: total ${outcome === 'odd' ? 'impar' : 'par'}`,
          probability: specialPrediction.teamParity?.[team]?.[outcome], odd: specialOdds.teamParity?.[team]?.[outcome],
          validationKey: `team_parity_${team}_${outcome}`, side: outcome,
        });
      }
      add({
        id: `special-first-score-${team}`, category: 'special-first-score',
        marketLabel: 'Primer equipo en anotar', name: `${game.teams[team].name} anota primero`,
        probability: specialPrediction.firstTeamScore?.[team], odd: specialOdds.firstTeamScore?.[team],
        validationKey: `first_score_${team}`, side: team,
      });
      add({
        id: `special-last-score-${team}`, category: 'special-last-score',
        marketLabel: 'Último equipo en anotar', name: `${game.teams[team].name} anota de último`,
        probability: specialPrediction.lastTeamScore?.[team], odd: specialOdds.lastTeamScore?.[team],
        validationKey: `last_score_${team}`, side: team,
      });
      add({
        id: `special-highest-${team}`, category: 'special-highest',
        marketLabel: 'Equipo con más carreras', name: `${game.teams[team].name} termina con más carreras`,
        probability: specialPrediction.highestScoring?.[team], odd: specialOdds.highestScoring?.[team],
        validationKey: `highest_scoring_${team}`, side: team,
      });
    }
    add({
      id: 'special-highest-draw', category: 'special-highest', marketLabel: 'Equipo con más carreras',
      name: 'Ambos equipos terminan con las mismas carreras', probability: specialPrediction.highestScoring?.draw,
      odd: specialOdds.highestScoring?.draw, validationKey: 'highest_scoring_draw', side: 'draw',
    });
    for (const outcome of ['yes', 'no']) {
      add({
        id: `special-extra-innings-${outcome}`, category: 'special-extra-innings',
        marketLabel: 'Entradas extra', name: `${outcome === 'yes' ? 'Sí' : 'No'} habrá entradas extra`,
        probability: specialPrediction.extraInnings?.[outcome], odd: specialOdds.extraInnings?.[outcome],
        validationKey: `extra_innings_${outcome}`, side: outcome,
      });
    }
    for (const [score, probability] of Object.entries(specialPrediction.correctScore || {})) {
      add({
        id: `special-correct-score-${score.replace(':', '-')}`, category: 'special-correct-score',
        marketLabel: 'Marcador exacto', name: `Marcador exacto ${score}`,
        probability, odd: specialOdds.correctScore?.[score], validationKey: `correct_score_${score.replace(':', '_')}`,
      });
    }
    for (const [selection, probability] of Object.entries(specialPrediction.halfFull || {})) {
      const price = specialOdds.halfFull?.[selection];
      if (!price) continue;
      const outcomeName = (outcome) => outcome === 'home' ? game.teams.home.name : (outcome === 'away' ? game.teams.away.name : 'empate');
      add({
        id: `special-half-full-${selection.replace(/[^a-z0-9]/gi, '-')}`, category: 'special-half-full',
        marketLabel: 'Primeras 5 entradas / resultado final',
        name: `${outcomeName(price.first5)} en primeras 5 / ${outcomeName(price.final)} al final`,
        probability, odd: price, validationKey: `half_full_${selection.replace(/[^a-z0-9]/gi, '_')}`,
      });
    }
    for (const [selection, probability] of Object.entries(specialPrediction.resultTotals || {})) {
      const price = specialOdds.resultTotals?.[selection];
      if (!price) continue;
      const outcomeName = price.outcome === 'home' ? game.teams.home.name : (price.outcome === 'away' ? game.teams.away.name : 'empate');
      add({
        id: `special-result-total-${selection.replace(/[^a-z0-9]/gi, '-')}`, category: `special-result-total-${price.line}`,
        marketLabel: 'Resultado y total de carreras',
        name: `${outcomeName} y ${price.side === 'over' ? 'más' : 'menos'} de ${price.line} carreras`,
        probability, odd: price, validationKey: `result_total_${selection.replace(/[^a-z0-9]/gi, '_')}`,
      });
    }

    const playerProbabilities = options.playerProbabilities || prediction.players || {};
    for (const [metric, playersByName] of Object.entries(odds?.playerProps || {})) {
      const calculatedPlayers = playerProbabilities?.[metric] || [];
      for (const [playerKey, offeredPlayer] of Object.entries(playersByName || {})) {
        const player = calculatedPlayers.find((candidate) => normalizedPersonName(candidate.name) === playerKey);
        if (!player) continue;
        const label = BASEBALL_PLAYER_MARKET_LABELS[metric] || metric;
        for (const [line, prices] of Object.entries(offeredPlayer.lines || {})) {
          for (const side of ['over', 'under']) {
            add({
              id: `player-${metric}-${player.id || playerKey}-${line}-${side}`,
              category: `player-${metric}-${playerKey}`,
              marketLabel: label,
              name: `${player.name}: ${side === 'over' ? 'más' : 'menos'} de ${line} ${label.toLowerCase()}`,
              probability: playerProbability(player, line, side),
              odd: prices?.[side],
              validationKey: `player_${metric}_${player.id || playerKey}_${side}_${lineKey(line)}`,
              scope: 'player', line: Number(line), side,
            });
          }
        }
      }
    }
  }

  // La recomendación destacada conserva una sola opción por familia para no
  // construir combinadas correlacionadas. El catálogo de Baseball, en cambio,
  // conserva TODAS las líneas exactas que superan el baremo y existen en
  // Bet365: ninguna cuota válida se oculta por pertenecer a la misma familia.
  const bestByCategory = new Map();
  for (const item of candidates) {
    const previous = bestByCategory.get(item.category);
    if (!previous || item.rawProbability > previous.rawProbability) bestByCategory.set(item.category, item);
  }
  const uniqueCandidates = [...new Map(candidates.map((item) => [item.id, item])).values()];
  const selectable = uniqueCandidates
    .sort((a, b) => b.rawProbability - a.rawProbability || b.odd - a.odd);
  const selections = [...bestByCategory.values()]
    .filter((item) => item.rawProbability >= highlightThreshold)
    .sort((a, b) => b.rawProbability - a.rawProbability || b.odd - a.odd)
    .slice(0, 3);
  const combinedOdd = selections.length ? selections.reduce((value, item) => value * item.odd, 1) : null;
  const combinedProbability = selections.length ? selections.reduce((value, item) => value * (item.rawProbability / 100), 1) * 100 : 0;
  return {
    selections,
    selectable,
    combinedOdd: combinedOdd == null ? null : Math.round(combinedOdd * 100) / 100,
    combinedProbability: Math.round((combinedProbability + Number.EPSILON) * 100) / 100,
    hasRealOdds: selectable.length > 0,
    selectableThreshold,
    highlightThreshold,
    dailyThreshold: BASEBALL_DAILY_MIN_PROBABILITY,
    minimumReliability,
    ...(isBaseball ? {
      winProbabilities: {
        home: probabilityValue(prediction.moneyline?.home),
        away: probabilityValue(prediction.moneyline?.away),
      },
    } : {}),
    source: 'empirical-exact',
  };
}

function baseballOddsShape(odds) {
  const totals = Object.fromEntries(Object.entries(odds?.totals || {}).map(([line, value]) => [line, {
    over: value.over ? { odd: oddValue(value.over), bookmaker: value.over.bookmaker } : null,
    under: value.under ? { odd: oddValue(value.under), bookmaker: value.under.bookmaker } : null,
  }]));
  const line = 1.5;
  return {
    ...odds,
    moneyline: {
      home: oddValue(odds?.moneyline?.home),
      away: oddValue(odds?.moneyline?.away),
    },
    totals,
    runLine: {
      home_minus_1_5: oddValue(odds?.spreads?.home?.[-line]),
      home_plus_1_5: oddValue(odds?.spreads?.home?.[line]),
      away_minus_1_5: oddValue(odds?.spreads?.away?.[-line]),
      away_plus_1_5: oddValue(odds?.spreads?.away?.[line]),
    },
  };
}

function dataQuality(prediction, odds, details) {
  const homeSamples = Number(prediction.engine?.samples?.homeTeam || 0);
  const awaySamples = Number(prediction.engine?.samples?.awayTeam || 0);
  const hasOdds = Object.keys(odds?.moneyline || {}).length > 0
    || Object.keys(odds?.totals || {}).length > 0
    || Object.keys(odds?.spreads || {}).length > 0
    || Object.keys(odds?.periods || {}).length > 0
    || Object.keys(odds?.playerProps || {}).length > 0
    || Object.keys(odds?.statistics?.hits?.total || {}).length > 0
    || Object.keys(odds?.teamTotals?.home || {}).length > 0
    || Object.keys(odds?.teamTotals?.away || {}).length > 0;
  const hasDetail = !!details;
  const checks = { hasHomeHistory: homeSamples > 0, hasAwayHistory: awaySamples > 0, hasOdds, hasDetail, hasValidation: !!prediction.engine?.validation };
  const score = Math.round(Object.values(checks).filter(Boolean).length / Object.keys(checks).length * 100);
  return {
    ...checks, homeSamples, awaySamples, score,
    // Cuándo se leyó la cuota. El proveedor no da marca de frescura (`update`
    // vuelve null), así que la ponemos nosotros para que la interfaz pueda
    // decir de qué momento es el precio en vez de presentarlo como actual.
    oddsCapturedAt: odds?.capturedAt || null,
    oddsPreMatch: odds?.preMatch === true,
    // Alias del contrato visual de Baseball. Son trazabilidad, no factores que
    // alteren la probabilidad.
    hasHomeStats: checks.hasHomeHistory,
    hasAwayStats: checks.hasAwayHistory,
    hasH2H: false,
    hasPitcherMatchup: !!details?.pitcherMatchup,
    hasPlayerHighlights: !!details?.playerHighlights,
  };
}

export async function analyzeSportGame(sport, game, options = {}) {
  const config = getMultisportConfig(sport);
  let odds = {
    moneyline: {}, totals: {}, spreads: {}, periods: {}, teamTotals: { home: {}, away: {} },
    statistics: { hits: { home: {}, away: {}, total: {} } }, playerProps: {},
    specials: {},
    catalog: [], rawBookmakers: [], source: `api-${config.oddsProvider}`,
  };
  // Una cuota solo vale si se capturó ANTES del primer lanzamiento: en cuanto el
  // partido arranca, Bet365 cierra el mercado previo y publica precios en vivo
  // que el cliente ya no puede tomar. Para partidos empezados no se pide cuota
  // (ni se gasta presupuesto): se conserva la última pre-partido guardada.
  const kickoffMs = new Date(game.date).getTime();
  const isPreMatch = !game.status?.isFinal && !game.status?.isLive
    && Number.isFinite(kickoffMs) && kickoffMs > Date.now();
  if (isPreMatch) {
    try {
      odds = await getSportOdds(config.key, game, {
        ttl: options.oddsTtl,
        mappingTtl: options.oddsMappingTtl,
      });
      odds = { ...odds, capturedAt: new Date().toISOString(), preMatch: true };
    }
    catch (error) { console.warn(`[${config.key}:odds] ${game.id}: ${error.message}`); }
  } else {
    const previous = await getSportAnalyses(pgPool, config.key, [game.id]).catch(() => []);
    const stored = previous?.[0]?.best_odds;
    if (stored && typeof stored === 'object' && stored.preMatch === true) odds = stored;
  }

  let pitcherMatchup = null;
  let playerHighlights = null;
  let details = null;
  const fixture = { ...game, context: { home: {}, away: {} } };
  if (config.key === 'baseball' && String(game.league?.id || '1') === '1') {
    const season = Number(String(game.season).slice(0, 4));
    [pitcherMatchup, playerHighlights] = await Promise.all([
      getMlbPitcherMatchup({
        gamePk: Number(game.providerFixtureId),
        home: { ...game.teams.home, probablePitcherId: game.teams.home.probablePitcherId, probablePitcherName: game.teams.home.probablePitcherName },
        away: { ...game.teams.away, probablePitcherId: game.teams.away.probablePitcherId, probablePitcherName: game.teams.away.probablePitcherName },
      }, season).catch(() => null),
      extractBaseballPlayerHighlights({
        gamePk: Number(game.providerFixtureId),
        home: { ...game.teams.home, probablePitcherId: game.teams.home.probablePitcherId, probablePitcherName: game.teams.home.probablePitcherName },
        away: { ...game.teams.away, probablePitcherId: game.teams.away.probablePitcherId, probablePitcherName: game.teams.away.probablePitcherName },
      }, season).catch(() => null),
    ]);
    fixture.context.home.starterId = game.teams.home.probablePitcherId || null;
    fixture.context.away.starterId = game.teams.away.probablePitcherId || null;
    fixture.context.home.starters = playerHighlights?.context?.homeStarters || [];
    fixture.context.away.starters = playerHighlights?.context?.awayStarters || [];
    details = { pitcherMatchup, playerHighlights };
  }

  const prediction = await computeMultisportEmpiricalPrediction(pgPool, { sport: config.key, fixture, odds });
  const playerProbabilities = buildEmpiricalPlayerProbabilities(playerHighlights, odds?.playerProps);
  const genericCombinada = buildMultisportCombinada(prediction, odds, game, { playerProbabilities });
  const probabilities = config.key === 'baseball'
    ? toBaseballProbabilityShape(prediction, { playerHighlights, playerProbabilities, pitcherMatchup })
    : prediction;
  // El shape de baseball conserva sus nombres visuales; las selecciones siguen
  // saliendo del mismo prediction empírico, no del motor Poisson anterior.
  const combinada = genericCombinada;
  const dq = dataQuality(prediction, odds, details);
  const storedOdds = config.key === 'baseball' ? baseballOddsShape(odds) : odds;
  let finalVerdict;
  try {
    finalVerdict = await buildMultisportFinalVerdict(pgPool, {
      sport: config.key,
      fixture,
      // El constructor necesita los objetos con atribución de bookmaker. La
      // forma visual reducida de Baseball se aplica solo al persistir `best_odds`.
      odds,
    });
  } catch (error) {
    console.error(`[${config.key}:final-verdict] ${game.id}: ${error.message}`);
    finalVerdict = {
      version: 1,
      status: 'unavailable',
      picks: [],
      h2h: [],
      error: 'No fue posible completar la muestra oficial',
    };
  }
  dq.hasH2H = finalVerdict.h2h?.length > 0;

  await Promise.all([
    saveSportAnalysis(pgPool, config.key, game, {
      analysis: {
        provider: game.dataProvider, providerFixtureId: game.providerFixtureId,
        pitcherMatchup, playerMarkets: playerProbabilities,
        evidence: prediction.engine,
        finalVerdict,
      },
      odds: storedOdds,
      probabilities,
      combinada,
      dataQuality: dq,
      cacheVersion: CACHE_VERSION,
    }),
    saveSportPrediction(pgPool, config.key, game, prediction),
  ]);
  return { game, prediction, probabilities, combinada, odds: storedOdds, dataQuality: dq, finalVerdict };
}

async function mapLimited(items, concurrency, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { result[index] = { ok: true, value: await mapper(items[index], index) }; }
      catch (error) { result[index] = { ok: false, error }; }
    }
  });
  await Promise.all(runners);
  return result;
}

async function analyzeSportDateInner(sport, date, options = {}) {
  const config = getMultisportConfig(sport);
  const allGames = await getSportGamesByDate(config.key, date, options);
  await Promise.all([persistSportSchedule(pgPool, config.key, date, allGames), persistSportGames(pgPool, config.key, allGames)]);
  const now = Date.now();
  // El pase pre-partido admitía partidos empezados hasta una hora antes
  // (`kickoff >= now - 60 min`). Eso guardaba la cuota EN VIVO de Bet365 y la
  // servía como si fuera la línea previa: nunca podía coincidir con lo que el
  // cliente veía en la casa. Solo entran partidos que aún no han empezado.
  const eligibleGames = options.pregame
    ? allGames.filter((game) => {
      const kickoff = new Date(game.date).getTime();
      return !game.status?.isFinal && !game.status?.isLive && Number.isFinite(kickoff)
        && kickoff > now && kickoff <= now + 3 * 60 * 60_000;
    })
    : allGames;
  let games = eligibleGames;
  let alreadyCurrent = 0;
  if (options.onlyMissingCurrent === true && eligibleGames.length) {
    const existing = await getSportAnalyses(pgPool, config.key, eligibleGames.map((game) => game.id));
    games = selectGamesNeedingCurrentAnalysis(eligibleGames, existing, CACHE_VERSION, {
      retryMissingOdds: config.key === 'baseball' && options.retryMissingOdds === true,
      now: options.now,
      maxOddsRetries: options.maxOddsRetries,
    });
    alreadyCurrent = eligibleGames.length - games.length;
  }
  const gameTimeoutMs = Number(options.gameTimeoutMs ?? SPORT_GAME_TIMEOUT_MS);
  const results = await mapLimited(games, options.concurrency || 2, (game) => withTimeout(
    analyzeSportGame(config.key, game, options),
    gameTimeoutMs,
    `${config.key}:analyze:${game.id}`,
  ));
  const failed = results.filter((row) => !row.ok);
  return {
    ok: failed.length === 0, sport: config.key, date, scheduled: allGames.length, total: games.length,
    analyzed: results.length - failed.length, alreadyCurrent, failed: failed.length,
    errors: failed.slice(0, 5).map((row) => row.error?.message || String(row.error)),
  };
}

export async function analyzeSportDate(sport, date, options = {}) {
  const config = getMultisportConfig(sport);
  if (!isIsoDate(date)) throw new Error(`Fecha inválida: ${date}`);
  // Techo de jornada además del de partido: si algo se cuelga fuera del bucle
  // de partidos (calendario, persistencia), el job falla y libera la cola en
  // vez de dejarla muerta hasta el siguiente despliegue.
  return withTimeout(
    analyzeSportDateInner(sport, date, options),
    Number(options.dateTimeoutMs ?? SPORT_DATE_TIMEOUT_MS),
    `${config.key}:analyzeDate:${date}`,
  );
}

export async function prepareSportDate(sport, date, options = {}) {
  const config = getMultisportConfig(sport);
  if (!isIsoDate(date)) throw new Error(`Fecha inválida: ${date}`);
  const games = await getSportGamesByDate(config.key, date, options);
  await Promise.all([
    persistSportSchedule(pgPool, config.key, date, games),
    persistSportGames(pgPool, config.key, games),
  ]);
  return { ok: true, sport: config.key, date, total: games.length, games };
}

export async function finalizeSportDate(sport, date, options = {}) {
  const config = getMultisportConfig(sport);
  if (!isIsoDate(date)) throw new Error(`Fecha inválida: ${date}`);
  const games = await getSportGamesByDate(config.key, date, { ...options, ttl: 120 });
  await persistSportGames(pgPool, config.key, games);
  const finals = games.filter((game) => game.status?.isFinal && game.scores?.home?.total != null && game.scores?.away?.total != null);
  const table = `${config.tablePrefix}_engine_team_stats`;
  const existing = finals.length
    ? await pgPool.query(
      `SELECT fixture_id FROM ${table}
       WHERE fixture_id = ANY($1::text[])
       GROUP BY fixture_id
       HAVING bool_and(COALESCE((stats->>'_detailsAvailable')::boolean,FALSE))`,
      [finals.map((game) => String(game.id))],
    )
    : { rows: [] };
  const done = new Set(existing.rows.map((row) => String(row.fixture_id)));
  const pending = options.force ? finals : finals.filter((game) => !done.has(String(game.id)));
  const results = await mapLimited(pending, options.concurrency || 2, async (game) => {
    const details = await getSportGameDetails(config.key, game).catch((error) => {
      console.warn(`[${config.key}:details] ${game.id}: ${error.message}`);
      return null;
    });
    const ingested = await ingestFinalSportGame(pgPool, config.key, game, details);
    await pgPool.query(
      `UPDATE ${config.tablePrefix}_engine_predictions
       SET actual=$2::jsonb,finalized_at=COALESCE(finalized_at,now()),updated_at=now()
       WHERE fixture_id=$1`,
      [String(game.id), JSON.stringify({ home: game.scores.home.total, away: game.scores.away.total, periods: game.periods, stats: details?.teams || null })],
    );
    return ingested;
  });
  const failed = results.filter((row) => !row.ok);
  return { ok: failed.length === 0, sport: config.key, date, finals: finals.length, alreadyIngested: done.size, ingested: results.length - failed.length, failed: failed.length, errors: failed.map((row) => row.error?.message).slice(0, 5) };
}

function localDay(iso, timeZone) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC' }).format(new Date(iso)); }
  catch { return new Date(iso).toISOString().slice(0, 10); }
}

function storedGame(row, config) {
  const competition = getSportCompetition(config.key, row.competition_id);
  return {
    id: String(row.fixture_id), providerFixtureId: String(row.provider_fixture_id), dataProvider: row.provider,
    date: row.kickoff, season: row.season,
    league: {
      id: row.competition_id,
      name: competition?.name || config.competitionLabel,
      providerLeagueId: competition?.providerLeagueId || null,
    },
    country: { name: competition?.country || 'Estados Unidos' },
    status: {
      short: row.status || 'NS', long: row.status || 'Programado',
      isFinal: row.status === 'FT', isLive: row.status === 'LIVE',
    },
    teams: {
      home: { id: row.home_team_id, name: row.home_team, logo: row.home_logo },
      away: { id: row.away_team_id, name: row.away_team, logo: row.away_logo },
    },
    scores: { home: { total: row.home_score == null ? null : Number(row.home_score) }, away: { total: row.away_score == null ? null : Number(row.away_score) } },
    periods: row.periods || {}, raw: null,
  };
}

export async function listSportFixtures(sport, date, options = {}) {
  const config = getMultisportConfig(sport);
  if (!isIsoDate(date)) throw new Error(`Fecha inválida: ${date}`);
  const start = new Date(`${date}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(`${date}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 2);
  const matchesTable = `${config.tablePrefix}_engine_matches`;
  const availableCompetitions = getSportCompetitions(config.key);
  const configuredCompetitionIds = new Set(availableCompetitions.map((competition) => String(competition.id)));
  const requestedCompetitions = new Set((options.competitionKeys || []).map(String));
  const competitionAllowed = (game) => {
    if (!configuredCompetitionIds.has(String(game.league?.id || ''))) return false;
    if (!requestedCompetitions.size) return true;
    const competition = getSportCompetition(config.key, game.league?.id);
    return requestedCompetitions.has(String(game.league?.id))
      || (competition && requestedCompetitions.has(competition.key));
  };
  let stored = [];
  try {
    const { rows } = await pgPool.query(
      `SELECT * FROM ${matchesTable} WHERE kickoff >= $1 AND kickoff < $2 ORDER BY kickoff`, [start, end]);
    stored = rows.map((row) => storedGame(row, config))
      .filter((game) => localDay(game.date, options.timeZone || 'UTC') === date && competitionAllowed(game));
  } catch {}
  let games = stored;
  const configuredCompetitions = availableCompetitions
    .filter((competition) => !requestedCompetitions.size
      || requestedCompetitions.has(competition.key)
      || requestedCompetitions.has(String(competition.id)));
  const storedCompetitionIds = new Set(stored.map((game) => String(game.league?.id || '')));
  const missingCompetitionKeys = configuredCompetitions
    .filter((competition) => !storedCompetitionIds.has(String(competition.id)))
    .map((competition) => competition.key);

  if (options.allowProviderFetch !== false && (!games.length || missingCompetitionKeys.length)) {
    // La fecha solicitada representa el calendario del usuario, no el del
    // proveedor. Consultar días adyacentes evita perder partidos nocturnos al
    // cruzar Bogotá/Nueva York con Europa o Asia; las respuestas quedan
    // cacheadas y esta ruta solo llega al proveedor cuando aún no hay DB.
    const providerDates = [-1, 0, 1].map((offset) => {
      const value = new Date(`${date}T12:00:00Z`);
      value.setUTCDate(value.getUTCDate() + offset);
      return value.toISOString().slice(0, 10);
    });
    const providerOptions = {
      ...options,
      competitionKeys: missingCompetitionKeys.length
        ? missingCompetitionKeys
        : configuredCompetitions.map((competition) => competition.key),
    };
    const attempts = await Promise.allSettled(providerDates.map((providerDate) => (
      getSportGamesByDate(config.key, providerDate, providerOptions)
    )));
    const fetched = attempts.filter((attempt) => attempt.status === 'fulfilled').map((attempt) => attempt.value);
    if (!fetched.length && !stored.length) {
      throw attempts.find((attempt) => attempt.status === 'rejected')?.reason || new Error('Calendario no disponible');
    }
    const fetchedForDay = fetched.flat()
      .filter((game) => localDay(game.date, options.timeZone || 'UTC') === date && competitionAllowed(game));
    games = [...new Map([...stored, ...fetchedForDay]
      .map((game) => [String(game.id), game])).values()]
      .sort((left, right) => new Date(left.date) - new Date(right.date));

    // Guardar el calendario ampliado evita repetir trabajo y permite que los
    // procesos de análisis/finalización encuentren exactamente los mismos IDs.
    if (fetchedForDay.length) {
      await persistSportGames(pgPool, config.key, fetchedForDay).catch((error) => {
        console.warn(`[${config.key}:schedule-cache] ${error.message}`);
      });
    }
  }
  const analyses = await getSportAnalyses(pgPool, config.key, games.map((game) => game.id)).catch(() => []);
  const currentAnalyses = analyses.filter((analysis) => Number(analysis.cache_version || 0) >= CACHE_VERSION);
  const map = new Map(currentAnalyses.map((analysis) => [String(analysis.fixture_id), analysis]));
  return games.map((game) => {
    const publicGame = { ...game };
    delete publicGame.raw;
    delete publicGame.espnOdds;
    delete publicGame.espnProviderFixtureId;
    return {
      ...publicGame,
      analysis: map.get(String(game.id)) || null,
      isAnalyzed: map.has(String(game.id)),
    };
  });
}

export { CACHE_VERSION as MULTISPORT_CACHE_VERSION };
