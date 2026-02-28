// League configuration for all target countries
// Division: 1 = first div, 2 = second div, 0 = cup/supercup/other
// Gender: M = men, W = women

export const LEAGUES = {
  // ===================== GERMANY =====================
  78:  { country: 'Germany', name: 'Bundesliga', division: 1, gender: 'M' },
  79:  { country: 'Germany', name: '2. Bundesliga', division: 2, gender: 'M' },
  81:  { country: 'Germany', name: 'DFB Pokal', division: 0, gender: 'M' },
  529: { country: 'Germany', name: 'DFL Super Cup', division: 0, gender: 'M' },
  506: { country: 'Germany', name: 'Frauen Bundesliga', division: 1, gender: 'W' },

  // ===================== SPAIN =====================
  140: { country: 'Spain', name: 'La Liga', division: 1, gender: 'M' },
  141: { country: 'Spain', name: 'Segunda División', division: 2, gender: 'M' },
  143: { country: 'Spain', name: 'Copa del Rey', division: 0, gender: 'M' },
  556: { country: 'Spain', name: 'Super Cup', division: 0, gender: 'M' },
  898: { country: 'Spain', name: 'Liga F', division: 1, gender: 'W' },

  // ===================== ENGLAND =====================
  39:  { country: 'England', name: 'Premier League', division: 1, gender: 'M' },
  40:  { country: 'England', name: 'Championship', division: 2, gender: 'M' },
  45:  { country: 'England', name: 'FA Cup', division: 0, gender: 'M' },
  48:  { country: 'England', name: 'League Cup', division: 0, gender: 'M' },
  528: { country: 'England', name: 'Community Shield', division: 0, gender: 'M' },
  44:  { country: 'England', name: 'WSL', division: 1, gender: 'W' },

  // ===================== ITALY =====================
  135: { country: 'Italy', name: 'Serie A', division: 1, gender: 'M' },
  136: { country: 'Italy', name: 'Serie B', division: 2, gender: 'M' },
  137: { country: 'Italy', name: 'Coppa Italia', division: 0, gender: 'M' },
  547: { country: 'Italy', name: 'Supercoppa', division: 0, gender: 'M' },
  723: { country: 'Italy', name: 'Serie A Femminile', division: 1, gender: 'W' },

  // ===================== COLOMBIA =====================
  239: { country: 'Colombia', name: 'Liga BetPlay', division: 1, gender: 'M' },
  240: { country: 'Colombia', name: 'Torneo BetPlay', division: 2, gender: 'M' },

  // ===================== BRAZIL =====================
  71:  { country: 'Brazil', name: 'Série A', division: 1, gender: 'M' },
  72:  { country: 'Brazil', name: 'Série B', division: 2, gender: 'M' },
  73:  { country: 'Brazil', name: 'Copa do Brasil', division: 0, gender: 'M' },
  475: { country: 'Brazil', name: 'Série A1 Feminino', division: 1, gender: 'W' },

  // ===================== FRANCE =====================
  61:  { country: 'France', name: 'Ligue 1', division: 1, gender: 'M' },
  62:  { country: 'France', name: 'Ligue 2', division: 2, gender: 'M' },
  66:  { country: 'France', name: 'Coupe de France', division: 0, gender: 'M' },
  526: { country: 'France', name: 'Trophée des Champions', division: 0, gender: 'M' },
  484: { country: 'France', name: 'D1 Arkema', division: 1, gender: 'W' },

  // ===================== SAUDI ARABIA =====================
  307: { country: 'Saudi Arabia', name: 'Pro League', division: 1, gender: 'M' },
  308: { country: 'Saudi Arabia', name: 'Division 1', division: 2, gender: 'M' },
  320: { country: 'Saudi Arabia', name: "King's Cup", division: 0, gender: 'M' },

  // ===================== ARGENTINA =====================
  128: { country: 'Argentina', name: 'Liga Profesional', division: 1, gender: 'M' },
  129: { country: 'Argentina', name: 'Primera Nacional', division: 2, gender: 'M' },
  130: { country: 'Argentina', name: 'Copa Argentina', division: 0, gender: 'M' },

  // ===================== MEXICO =====================
  262: { country: 'Mexico', name: 'Liga MX', division: 1, gender: 'M' },
  263: { country: 'Mexico', name: 'Liga de Expansión', division: 2, gender: 'M' },
  749: { country: 'Mexico', name: 'Liga MX Femenil', division: 1, gender: 'W' },
};

export const ALL_LEAGUE_IDS = Object.keys(LEAGUES).map(Number);

// Get primary league IDs (1st and 2nd div) for a country
export function getCountryLeagueIds(country) {
  return Object.entries(LEAGUES)
    .filter(([, l]) => l.country === country && (l.division === 1 || l.division === 2) && l.gender === 'M')
    .map(([id]) => Number(id));
}

// Get all countries
export function getCountries() {
  const countries = new Set(Object.values(LEAGUES).map(l => l.country));
  return [...countries].sort();
}
