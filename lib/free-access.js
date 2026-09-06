// Server boundary: never send hidden selections, evidence or labels to Free.
import { marketLabel } from './market-labels.js';
import { meetsReliability, reliabilityPercent } from './recommendation-policy.js';
import { entryReliabilityPercent } from './reliability.js';

const META = ['fixtureId', 'fixture_id', 'homeTeam', 'awayTeam', 'homeLogo', 'awayLogo', 'homeId', 'awayId', 'league', 'leagueId', 'leagueLogo', 'kickoff', 'status', 'goals', 'score', 'home_team', 'away_team', 'home_team_id', 'away_team_id', 'league_name', 'start_time', 'date', 'scores'];
const PERIODS = { firstHalf: 'Primera mitad', secondHalf: 'Segunda mitad', quarter1: 'Primer cuarto', quarter2: 'Segundo cuarto', quarter3: 'Tercer cuarto', quarter4: 'Cuarto cuarto', first3: 'Primeras 3 entradas', first4_5: 'Primeras 4,5 entradas', first5: 'Primeras 5 entradas', first7: 'Primeras 7 entradas' };
const validPercent = value => value != null && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100;

export function freeAnalysis(source, sport = 'football') {
  if (!source) return null;
  const inner = source.analysis || source;
  const doc = sport === 'football' ? { ...inner, ...source } : source;
  const candidates = new Map();
  const paidCatalog = doc.combinada?.selectable || doc.combinada?.selections || [];
  const add = item => {
    if (!item?.id || !item.name || !validPercent(item.probability) || !meetsReliability(item.reliability, 90)) return;
    if (!candidates.has(item.id)) candidates.set(item.id, item);
  };
  for (const pick of paidCatalog) {
    add({ id: pick.id, name: pick.name || pick.pick, probability: pick.rawProbability ?? pick.probability,
      reliability: reliabilityPercent(pick.confidence ?? pick.reliability), odd: pick.odd });
  }
  if (sport === 'football') {
    for (const [id, entry] of Object.entries({ ...(inner._scored || source._scored || {}), ...(inner._freeScored || source._freeScored || {}) })) {
      const name = marketLabel(id, { home: doc.homeTeam, away: doc.awayTeam });
      if (!name || name === id) continue;
      add({ id, name, probability: Number(entry.prob_final ?? entry.prob) * 100,
        reliability: reliabilityPercent(entry.confidence) });
    }
  } else {
    const prediction = source.probabilities?.evidence || source.probabilities;
    const home = source.home_team || 'Local', away = source.away_team || 'Visitante';
    const unit = sport === 'baseball' ? 'carreras' : 'puntos';
    const entry = (id, name, value) => {
      if (value?.rawProbability == null || !value.evidence) return;
      // Same evidence/posterior as Pro, evaluated against the Free floor (60%).
      add({ id, name, probability: Number(value.rawProbability) * 100,
        reliability: entryReliabilityPercent(value, 60) });
    };
    const ladder = (id, title, lines, label = unit) => {
      for (const [line, values] of Object.entries(lines || {})) {
        if (!Number.isFinite(Number(line))) continue;
        for (const side of ['over', 'under']) entry(`${id}-${line}-${side}`, `${title}${side === 'over' ? 'Más' : 'Menos'} de ${line} ${label}`, values?.[side]);
      }
    };
    const group = (p, prefix = '', title = '') => {
      if (!p) return;
      entry(`${prefix}ml-home`, `${title}${home} gana`, p.moneyline?.home);
      entry(`${prefix}ml-away`, `${title}${away} gana`, p.moneyline?.away);
      entry(`${prefix}ml-draw`, `${title}Empate`, p.moneyline?.draw);
      ladder(`${prefix}total`, title, p.totals?.lines || p.totals);
      ladder(`${prefix}home-total`, `${title}${home}: `, p.teamTotals?.home);
      ladder(`${prefix}away-total`, `${title}${away}: `, p.teamTotals?.away);
      for (const [key, stat] of Object.entries(p.statistics || {})) {
        for (const side of ['home', 'away', 'total']) ladder(`${prefix}stat-${key}-${side}`, `${title}${side === 'home' ? home + ': ' : side === 'away' ? away + ': ' : ''}`, stat[side], stat.label || key);
      }
    };
    group(prediction);
    for (const [key, period] of Object.entries(prediction?.periods || {})) group(period, `${key}-`, `${period.label || PERIODS[key] || key} · `);
  }
  const options = [...candidates.values()].sort((a, b) => b.probability - a.probability || b.reliability - a.reliability || a.id.localeCompare(b.id));
  const selected = options.find(item => item.probability >= 60 && item.probability <= 70) || null;
  const visible = selected ? { id: selected.id, name: selected.name, probability: selected.probability, reliability: selected.reliability,
    ...(Number(selected.odd) >= 1.2 ? { odd: Number(selected.odd) } : {}) } : null;
  return {
    ...Object.fromEntries(META.filter(key => doc[key] != null).map(key => [key, doc[key]])),
    access: 'free',
    freePreview: {
      selection: visible,
      // Only actual Pro recommendations, never frequency-grid extremes such
      // as 'over 0' with 100% of historical samples. Match Pro's display rule.
      // No canonical IDs, labels, category, odds, sample or metadata leave here.
      locked: paidCatalog.filter(item => item.id !== selected?.id
        && validPercent(item.rawProbability ?? item.probability)
        && Number(item.rawProbability ?? item.probability) > 70)
        .map(item => ({ probability: Math.min(95, Math.floor(Number(item.rawProbability ?? item.probability) * 100) / 100) }))
        .sort((a, b) => b.probability - a.probability),
      unavailable: visible ? null : 'Todavía no hay una opción entre 60 y 70% con fiabilidad mínima del 90% para este partido.',
    },
  };
}
