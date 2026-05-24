// League configuration — IDs from api-football.com v3
// Division: 1 = first div, 2 = second div, 0 = cup/international
// Gender: M = men, W = women

export const LEAGUES = {
  // ===================== INTERNATIONAL — FIFA =====================
  1:   { country: 'World', name: 'FIFA World Cup',          division: 0, gender: 'M' },
  10:  { country: 'World', name: 'Amistosos FIFA',          division: 0, gender: 'M' },
  667: { country: 'World', name: 'Amistosos de Clubes',     division: 0, gender: 'M' },

  // ===================== CONTINENTAL CUPS — SELECCIONES =====================
  // IDs estables en API-Football, verificar con /leagues?id=N antes de cambiar.
  4:   { country: 'Europe',        name: 'Eurocopa',              division: 0, gender: 'M' },
  5:   { country: 'Europe',        name: 'UEFA Nations League',   division: 0, gender: 'M' },
  9:   { country: 'South America', name: 'Copa América',          division: 0, gender: 'M' },
  6:   { country: 'Africa',        name: 'Copa África de Naciones', division: 0, gender: 'M' },
  7:   { country: 'Asia',          name: 'AFC Asian Cup',         division: 0, gender: 'M' },

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

  // ===================== NETHERLANDS =====================
  88:  { country: 'Netherlands', name: 'Eredivisie',     division: 1, gender: 'M' },
  89:  { country: 'Netherlands', name: 'Eerste Divisie', division: 2, gender: 'M' },
  90:  { country: 'Netherlands', name: 'KNVB Beker',     division: 0, gender: 'M' },

  // ===================== PORTUGAL =====================
  94:  { country: 'Portugal', name: 'Primeira Liga', division: 1, gender: 'M' },
  95:  { country: 'Portugal', name: 'Liga Portugal 2', division: 2, gender: 'M' },
  96:  { country: 'Portugal', name: 'Taça de Portugal', division: 0, gender: 'M' },

  // ===================== BELGIUM =====================
  144: { country: 'Belgium', name: 'Jupiler Pro League', division: 1, gender: 'M' },
  147: { country: 'Belgium', name: 'Beker van België',   division: 0, gender: 'M' },

  // ===================== SCOTLAND =====================
  179: { country: 'Scotland', name: 'Premiership', division: 1, gender: 'M' },
  181: { country: 'Scotland', name: 'Championship', division: 2, gender: 'M' },

  // ===================== SWITZERLAND =====================
  207: { country: 'Switzerland', name: 'Super League', division: 1, gender: 'M' },

  // ===================== AUSTRIA =====================
  218: { country: 'Austria', name: 'Bundesliga', division: 1, gender: 'M' },

  // ===================== GREECE =====================
  197: { country: 'Greece', name: 'Super League 1', division: 1, gender: 'M' },

  // ===================== NORWAY =====================
  103: { country: 'Norway', name: 'Eliteserien', division: 1, gender: 'M' },

  // ===================== SWEDEN =====================
  113: { country: 'Sweden', name: 'Allsvenskan', division: 1, gender: 'M' },

  // ===================== DENMARK =====================
  119: { country: 'Denmark', name: 'Superliga', division: 1, gender: 'M' },

  // ===================== POLAND =====================
  106: { country: 'Poland', name: 'Ekstraklasa', division: 1, gender: 'M' },

  // ===================== UKRAINE =====================
  333: { country: 'Ukraine', name: 'Premier League', division: 1, gender: 'M' },

  // ===================== CZECH REPUBLIC =====================
  345: { country: 'Czech Republic', name: 'Czech Liga', division: 1, gender: 'M' },

  // ===================== ROMANIA =====================
  283: { country: 'Romania', name: 'Liga I', division: 1, gender: 'M' },

  // ===================== CROATIA =====================
  210: { country: 'Croatia', name: 'HNL', division: 1, gender: 'M' },

  // ===================== SERBIA =====================
  286: { country: 'Serbia', name: 'SuperLiga', division: 1, gender: 'M' },

  // ===================== HUNGARY =====================
  271: { country: 'Hungary', name: 'NB I', division: 1, gender: 'M' },

  // ===================== RUSSIA =====================
  235: { country: 'Russia', name: 'Premier League', division: 1, gender: 'M' },

  // ===================== USA =====================
  253: { country: 'USA', name: 'Major League Soccer', division: 1, gender: 'M' },
  257: { country: 'USA', name: 'US Open Cup',         division: 0, gender: 'M' },

  // ===================== JAPAN =====================
  98:  { country: 'Japan', name: 'J1 League', division: 1, gender: 'M' },
  99:  { country: 'Japan', name: 'J2 League', division: 2, gender: 'M' },

  // ===================== SOUTH KOREA =====================
  292: { country: 'South Korea', name: 'K League 1', division: 1, gender: 'M' },

  // ===================== CHINA =====================
  169: { country: 'China', name: 'Super League', division: 1, gender: 'M' },

  // ===================== AUSTRALIA =====================
  188: { country: 'Australia', name: 'A-League', division: 1, gender: 'M' },

  // ===================== ASIA — INTERNATIONAL =====================
  17:  { country: 'Asia', name: 'AFC Champions League', division: 0, gender: 'M' },

  // ===================== AFRICA =====================
  12:  { country: 'Africa', name: 'CAF Champions League', division: 0, gender: 'M' },
  20:  { country: 'Africa', name: 'CAF Confederation Cup', division: 0, gender: 'M' },
  233: { country: 'Egypt',  name: 'Premier League',     division: 1, gender: 'M' },
  288: { country: 'South Africa', name: 'PSL',          division: 1, gender: 'M' },

  // ===================== CHILE =====================
  265: { country: 'Chile', name: 'Primera División', division: 1, gender: 'M' },

  // ===================== ECUADOR =====================
  242: { country: 'Ecuador', name: 'Serie A', division: 1, gender: 'M' },

  // ===================== PERU =====================
  281: { country: 'Peru', name: 'Liga 1', division: 1, gender: 'M' },

  // ===================== URUGUAY =====================
  268: { country: 'Uruguay', name: 'Primera División', division: 1, gender: 'M' },

  // ===================== PARAGUAY =====================
  250: { country: 'Paraguay', name: 'División Profesional', division: 1, gender: 'M' },

  // ===================== USA-INTERNATIONAL =====================
  16:  { country: 'World', name: 'FIFA Club World Cup', division: 0, gender: 'M' },
};

export const ALL_LEAGUE_IDS = Object.keys(LEAGUES).map(Number);

export const FLAGS = {
  World: '🌍', Europe: '🇪🇺', 'South America': '🌎', 'North America': '🌎',
  Asia: '🌏', Africa: '🌍', Oceania: '🌊',
  England: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', Spain: '🇪🇸', Germany: '🇩🇪', Italy: '🇮🇹',
  France: '🇫🇷', Turkey: '🇹🇷', Mexico: '🇲🇽', Colombia: '🇨🇴',
  Argentina: '🇦🇷', Brazil: '🇧🇷', 'Saudi Arabia': '🇸🇦',
};
