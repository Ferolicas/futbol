// Build the "Apuesta del Día" for baseball — selects best picks across
// the day's analyzed games, weighted by probability and live status.

const cap = (v) => Math.min(95, Math.max(0, v ?? 0));

// Priority: 2 = upcoming, 1 = live, 0 = finished
const isLive = (s) => ['LIVE', 'IN', 'IN1', 'IN2', 'IN3', 'IN4', 'IN5', 'IN6', 'IN7', 'IN8', 'IN9'].includes(s);
const isFinished = (s) => ['FT', 'AOT'].includes(s);

function gamePriority(g) {
  const s = g?.status?.short;
  if (isFinished(s)) return 0;
  if (isLive(s)) return 1;
  return 2; // NS / upcoming
}

/**
 * Extract market candidates from a baseball analyzed game.
 * Returns array of { matchName, market, name, probability, odd, cat, priority }.
 */
function extractCandidatesFromGame(game) {
  const a = game.analysis;
  if (!a?.probabilities) return [];

  const probs = a.probabilities;
  const bestOdds = a.best_odds;
  const matchName = `${game.teams?.home?.name || a.home_team} vs ${game.teams?.away?.name || a.away_team}`;
  const priority = gamePriority(game);
  const out = [];

  // Moneyline
  if (probs.moneyline?.home != null) {
    const p = cap(probs.moneyline.home);
    if (p >= 60) out.push({
      matchName, market: 'Moneyline', name: `${a.home_team || 'Home'} gana`,
      probability: p, odd: bestOdds?.moneyline?.home || null,
      cat: 'Ganador', priority, fixtureId: game.id,
    });
  }
  if (probs.moneyline?.away != null) {
    const p = cap(probs.moneyline.away);
    if (p >= 60) out.push({
      matchName, market: 'Moneyline', name: `${a.away_team || 'Away'} gana`,
      probability: p, odd: bestOdds?.moneyline?.away || null,
      cat: 'Ganador', priority, fixtureId: game.id,
    });
  }

  // Totals — best line first
  const bestLine = probs.totals?.bestLine;
  if (bestLine && probs.totals.lines?.[bestLine]) {
    const t = probs.totals.lines[bestLine];
    if (t.over >= 60) {
      out.push({
        matchName, market: `Total Over ${bestLine}`, name: `Over ${bestLine} carreras`,
        probability: t.over, odd: bestOdds?.totals?.[bestLine]?.over?.odd || null,
        cat: 'Carreras', priority, fixtureId: game.id,
      });
    }
    if (t.under >= 60) {
      out.push({
        matchName, market: `Total Under ${bestLine}`, name: `Under ${bestLine} carreras`,
        probability: t.under, odd: bestOdds?.totals?.[bestLine]?.under?.odd || null,
        cat: 'Carreras', priority, fixtureId: game.id,
      });
    }
  }

  // Run line
  if (probs.runLine?.home_minus_1_5 >= 60) {
    out.push({
      matchName, market: 'Run Line -1.5', name: `${a.home_team} -1.5`,
      probability: probs.runLine.home_minus_1_5, odd: null,
      cat: 'Run Line', priority, fixtureId: game.id,
    });
  }
  if (probs.runLine?.away_plus_1_5 >= 60) {
    out.push({
      matchName, market: 'Run Line +1.5', name: `${a.away_team} +1.5`,
      probability: probs.runLine.away_plus_1_5, odd: null,
      cat: 'Run Line', priority, fixtureId: game.id,
    });
  }

  // F5
  if (probs.f5?.moneyline?.home >= 60) {
    out.push({
      matchName, market: 'F5 Moneyline', name: `${a.home_team} F5`,
      probability: probs.f5.moneyline.home, odd: null,
      cat: 'F5', priority, fixtureId: game.id,
    });
  }

  // BTTS
  if (probs.btts?.yes >= 65) {
    out.push({
      matchName, market: 'Both teams score', name: 'Ambos anotan 1+',
      probability: probs.btts.yes, odd: null,
      cat: 'BTTS', priority, fixtureId: game.id,
    });
  }

  return out;
}

/**
 * Build the daily combined bet ("Apuesta del Día") for baseball.
 * Picks top 5 candidates across all analyzed games, prioritizing upcoming/live,
 * computes combined probability and combined odd (when all picks have real odds).
 */
export function buildBaseballApuestaDelDia(analyzedGames, { minProb = 60, maxPicks = 5 } = {}) {
  const all = [];
  for (const g of analyzedGames || []) {
    if (!g.analysis) continue;
    all.push(...extractCandidatesFromGame(g));
  }

  // Filter by probability threshold and dedupe by fixture (1 pick max per game)
  const filtered = all.filter(c => c.probability >= minProb);
  const byFixture = new Map();
  for (const c of filtered) {
    const ex = byFixture.get(c.fixtureId);
    if (!ex || c.probability > ex.probability) byFixture.set(c.fixtureId, c);
  }

  // Sort: priority desc (upcoming > live > finished), then probability desc
  const ranked = Array.from(byFixture.values())
    .sort((a, b) => (b.priority - a.priority) || (b.probability - a.probability))
    .slice(0, maxPicks);

  if (ranked.length === 0) return null;

  const combinedProbability = ranked.reduce((acc, r) => acc * (r.probability / 100), 1);
  const allHaveOdds = ranked.every(r => r.odd && r.odd > 1);
  const combinedOdd = allHaveOdds ? ranked.reduce((acc, r) => acc * r.odd, 1) : null;

  return {
    selections: ranked,
    combinedProbability: Math.round(combinedProbability * 100),
    combinedOdd: combinedOdd ? +combinedOdd.toFixed(2) : null,
    hasRealOdds: allHaveOdds,
  };
}

/**
 * Build a custom combinada from user-selected market keys.
 * selectedMarkets shape: { fixtureId: { marketKey: { label, probability, odd, cat } } }
 */
export function buildCustomBaseballCombinada(selectedMarkets, gamesById) {
  const selections = [];
  for (const [fid, markets] of Object.entries(selectedMarkets || {})) {
    const game = gamesById[fid];
    if (!game) continue;
    const matchName = `${game.teams?.home?.name || game.analysis?.home_team} vs ${game.teams?.away?.name || game.analysis?.away_team}`;
    for (const [key, m] of Object.entries(markets)) {
      selections.push({
        matchName,
        market: m.label || key,
        name: m.name || m.label || key,
        probability: m.probability,
        odd: m.odd || null,
        cat: m.cat || '',
        fixtureId: Number(fid),
        marketKey: key,
        priority: gamePriority(game),
      });
    }
  }
  if (selections.length === 0) return { selections: [], combinedProbability: 0, combinedOdd: null, hasRealOdds: false };

  const combinedProbability = selections.reduce((acc, r) => acc * (r.probability / 100), 1);
  const allHaveOdds = selections.every(r => r.odd && r.odd > 1);
  const combinedOdd = allHaveOdds ? selections.reduce((acc, r) => acc * r.odd, 1) : null;

  return {
    selections,
    combinedProbability: Math.round(combinedProbability * 100),
    combinedOdd: combinedOdd ? +combinedOdd.toFixed(2) : null,
    hasRealOdds: allHaveOdds,
  };
}
