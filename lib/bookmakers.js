// ===================== BOOKMAKER CONFIGURATION =====================
// Maps user country (detected via timezone) to preferred bookmakers
// and provides logo URLs + odds selection logic.

export const TIMEZONE_TO_COUNTRY = {
  // Spain
  'Europe/Madrid': 'ES',
  'Atlantic/Canary': 'ES',
  // Mexico
  'America/Mexico_City': 'MX',
  'America/Cancun': 'MX',
  'America/Monterrey': 'MX',
  'America/Tijuana': 'MX',
  'America/Chihuahua': 'MX',
  'America/Merida': 'MX',
  'America/Mazatlan': 'MX',
  'America/Hermosillo': 'MX',
  // Argentina
  'America/Argentina/Buenos_Aires': 'AR',
  'America/Argentina/Cordoba': 'AR',
  'America/Argentina/Mendoza': 'AR',
  // Colombia
  'America/Bogota': 'CO',
  // Chile
  'America/Santiago': 'CL',
  // Peru
  'America/Lima': 'PE',
  // UK
  'Europe/London': 'GB',
  // Italy
  'Europe/Rome': 'IT',
  // Germany
  'Europe/Berlin': 'DE',
  // France
  'Europe/Paris': 'FR',
  // Portugal
  'Europe/Lisbon': 'PT',
  // Brazil
  'America/Sao_Paulo': 'BR',
  'America/Fortaleza': 'BR',
  'America/Recife': 'BR',
  // USA
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Los_Angeles': 'US',
  'America/Phoenix': 'US',
};

// Bookmaker preference order by country
// SOLO 4 casas autorizadas (decisión del usuario): bet365, bwin, 1xbet, betano.
// El orden por país solo decide la preferencia de logo cuando varias cotizan el
// mismo mercado; la selección real sale de allBookmakerOdds (que ya está filtrado
// a estas 4). Ninguna otra casa puede aparecer.
export const COUNTRY_BOOKMAKERS = {
  ES: ['bwin', 'bet365', '1xbet', 'betano'],
  MX: ['bet365', 'betano', '1xbet', 'bwin'],
  AR: ['bet365', 'betano', '1xbet', 'bwin'],
  CO: ['bet365', 'betano', '1xbet', 'bwin'],
  CL: ['bet365', 'betano', '1xbet', 'bwin'],
  PE: ['bet365', 'betano', '1xbet', 'bwin'],
  BR: ['betano', 'bet365', '1xbet', 'bwin'],
  GB: ['bet365', 'bwin', '1xbet', 'betano'],
  IT: ['bet365', 'bwin', 'betano', '1xbet'],
  DE: ['bet365', 'bwin', '1xbet', 'betano'],
  FR: ['bwin', 'bet365', 'betano', '1xbet'],
  PT: ['betano', 'bet365', 'bwin', '1xbet'],
  US: ['bet365', 'bwin', '1xbet', 'betano'],
  default: ['bet365', 'bwin', '1xbet', 'betano'],
};

// Bookmaker logo URLs (small favicons / brand logos)
// Logo del bookmaker. bet365 tiene asset local; el resto usaba favicon.ico
// directo del sitio (hotlink-protegido / 404 — p.ej. 1xbet no cargaba). Se pasa
// al servicio de favicons de Google (estable, sin hotlink protection). El render
// además cae al NOMBRE del bookmaker con onError si alguno fallara.
const favicon = (domain) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
export const BOOKMAKER_LOGOS = {
  'bet365': '/Bet365-Logo.png',
  'bwin': favicon('bwin.com'),
  '1xbet': favicon('1xbet.com'),
  'betway': favicon('betway.com'),
  'pinnacle': favicon('pinnacle.com'),
  'william hill': favicon('williamhill.com'),
  'betfair': favicon('betfair.com'),
  'caliente': favicon('caliente.mx'),
  'betplay': favicon('betplay.com.co'),
  'betano': favicon('betano.com'),
  'draftkings': favicon('draftkings.com'),
  'fanduel': favicon('fanduel.com'),
  'unibet': favicon('unibet.com'),
  'tipico': favicon('tipico.de'),
  'snai': favicon('snai.it'),
  'betclic': favicon('betclic.fr'),
  'paddypower': favicon('paddypower.com'),
  'ladbrokes': favicon('ladbrokes.com'),
  'caesars': favicon('caesars.com'),
  'betmgm': favicon('betmgm.com'),
  'winamax': favicon('winamax.fr'),
  'sisal': favicon('sisal.it'),
};

/**
 * Select the best bookmaker odds for a given market based on user country.
 *
 * @param {object} oddsData - The full odds object from the analysis
 * @param {string} marketKey - The market key (e.g., 'matchWinner', 'overUnder', 'btts')
 * @param {string} country - ISO country code
 * @returns {{ bookmaker: string, odds: object } | null}
 */
export function selectBookmakerOdds(oddsData, marketKey, country) {
  if (!oddsData) return null;

  const prefs = COUNTRY_BOOKMAKERS[country] || COUNTRY_BOOKMAKERS.default;

  // If we have allBookmakerOdds array (from api-football extractOdds)
  const allBks = oddsData.allBookmakerOdds || oddsData._allBookmakers;
  if (allBks && Array.isArray(allBks)) {
    for (const pref of prefs) {
      const bk = allBks.find(b =>
        b.name?.toLowerCase().includes(pref)
      );
      // Support both structures: bk.markets[key] and bk[key] directly
      const mkData = bk?.markets?.[marketKey] || bk?.[marketKey];
      if (mkData) {
        return { bookmaker: bk.name || pref, odds: mkData };
      }
    }
    // Fallback to first available bookmaker que SÍ ofrece el mercado.
    const first = allBks.find(b => (b.markets?.[marketKey] || b[marketKey]));
    if (first) {
      return {
        bookmaker: first.name || 'default',
        odds: first.markets?.[marketKey] || first[marketKey],
      };
    }
  }

  // SIN fallback a cuota agregada "sin logo": si ningún bookmaker autorizado de
  // allBookmakerOdds cotiza el mercado, NO se atribuye (regla inviolable — el
  // frontend no debe renderizar cuotas fantasma sin bookmaker real).
  return null;
}
