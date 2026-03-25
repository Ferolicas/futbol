// League configuration — IDs from api-football.com v3
// Division: 1 = first div, 2 = second div, 0 = cup/international
// Gender: M = men, W = women

export const LEAGUES = {
  // ===================== INTERNATIONAL — FIFA =====================
  1:   { country: 'World', name: 'FIFA World Cup', division: 0, gender: 'M' },
  10:  { country: 'World', name: 'Amistosos FIFA', division: 0, gender: 'M' },

  // ============= CLASIFICATORIOS MUNDIAL 2026 ===================
  32:  { country: 'Europe',        name: 'Clasificatorio UEFA',     division: 0, gender: 'M' },
  33:  { country: 'South America', name: 'Clasificatorio CONMEBOL', division: 0, gender: 'M' },
  34:  { country: 'Asia',          name: 'Clasificatorio AFC',      division: 0, gender: 'M' },
  35:  { country: 'North America', name: 'Clasificatorio CONCACAF', division: 0, gender: 'M' },
  36:  { country: 'Africa',        name: 'Clasificatorio CAF',      division: 0, gender: 'M' },
  37:  { country: 'Oceania',       name: 'Clasificatorio OFC',      division: 0, gender: 'M' },
  877: { country: 'World',         name: 'Repechaje Intercontinental', division: 0, gender: 'M' },

  // ===================== UEFA =====================
  2:   { country: 'Europe', name: 'Champions League', division: 0, gender: 'M' },
  3:   { country: 'Europe', name: 'Europa League', division: 0, gender: 'M' },
  848: { country: 'Europe', name: 'Conference League', division: 0, gender: 'M' },

  // ===================== CONMEBOL =====================
  11:  { country: 'South America', name: 'Sudamericana', division: 0, gender: 'M' },
  13:  { country: 'South America', name: 'Libertadores', division: 0, gender: 'M' },

  // ===================== CONCACAF =====================
  26:  { country: 'North America', name: 'Champions Cup', division: 0, gender: 'M' },

  // ===================== ENGLAND =====================
  39:  { country: 'England', name: 'Premier League', division: 1, gender: 'M' },
  40:  { country: 'England', name: 'Championship', division: 2, gender: 'M' },
  41:  { country: 'England', name: 'League One', division: 2, gender: 'M' },
  45:  { country: 'England', name: 'FA Cup', division: 0, gender: 'M' },

  // ===================== SPAIN =====================
  140: { country: 'Spain', name: 'La Liga', division: 1, gender: 'M' },
  141: { country: 'Spain', name: 'La Liga 2', division: 2, gender: 'M' },
  143: { country: 'Spain', name: 'Copa del Rey', division: 0, gender: 'M' },

  // ===================== GERMANY =====================
  78:  { country: 'Germany', name: 'Bundesliga', division: 1, gender: 'M' },
  79:  { country: 'Germany', name: '2. Bundesliga', division: 2, gender: 'M' },
  81:  { country: 'Germany', name: 'DFB Pokal', division: 0, gender: 'M' },

  // ===================== ITALY =====================
  135: { country: 'Italy', name: 'Serie A', division: 1, gender: 'M' },
  136: { country: 'Italy', name: 'Serie B', division: 2, gender: 'M' },
  137: { country: 'Italy', name: 'Coppa Italia', division: 0, gender: 'M' },

  // ===================== FRANCE =====================
  61:  { country: 'France', name: 'Ligue 1', division: 1, gender: 'M' },
  62:  { country: 'France', name: 'Ligue 2', division: 2, gender: 'M' },
  66:  { country: 'France', name: 'Coupe de France', division: 0, gender: 'M' },

  // ===================== TURKEY =====================
  203: { country: 'Turkey', name: 'Süper Lig', division: 1, gender: 'M' },
  156: { country: 'Turkey', name: 'Türkiye Kupası', division: 0, gender: 'M' },

  // ===================== MEXICO =====================
  262: { country: 'Mexico', name: 'Liga MX', division: 1, gender: 'M' },

  // ===================== COLOMBIA =====================
  239: { country: 'Colombia', name: 'Liga BetPlay', division: 1, gender: 'M' },
  240: { country: 'Colombia', name: 'Liga BetPlay 2', division: 2, gender: 'M' },
  241: { country: 'Colombia', name: 'Copa Colombia', division: 0, gender: 'M' },

  // ===================== ARGENTINA =====================
  128: { country: 'Argentina', name: 'Liga Profesional', division: 1, gender: 'M' },
  130: { country: 'Argentina', name: 'Copa Argentina', division: 0, gender: 'M' },
  131: { country: 'Argentina', name: 'Copa de la Superliga', division: 0, gender: 'M' },

  // ===================== BRAZIL =====================
  71:  { country: 'Brazil', name: 'Brasileirão A', division: 1, gender: 'M' },
  73:  { country: 'Brazil', name: 'Copa Betano', division: 0, gender: 'M' },
  475: { country: 'Brazil', name: 'Campeonato Gaúcho', division: 0, gender: 'M' },
  476: { country: 'Brazil', name: 'Campeonato Mineiro', division: 0, gender: 'M' },

  // ===================== SAUDI ARABIA =====================
  307: { country: 'Saudi Arabia', name: 'Pro League', division: 1, gender: 'M' },
};

export const ALL_LEAGUE_IDS = Object.keys(LEAGUES).map(Number);

export const FLAGS = {
  World: '🌍', Europe: '🇪🇺', 'South America': '🌎', 'North America': '🌎',
  Asia: '🌏', Africa: '🌍', Oceania: '🌊',
  England: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', Spain: '🇪🇸', Germany: '🇩🇪', Italy: '🇮🇹',
  France: '🇫🇷', Turkey: '🇹🇷', Mexico: '🇲🇽', Colombia: '🇨🇴',
  Argentina: '🇦🇷', Brazil: '🇧🇷', 'Saudi Arabia': '🇸🇦',
};
