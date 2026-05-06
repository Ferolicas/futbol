// Currency conversion using open.er-api.com
// Free, no API key, supports 170+ currencies including COP, ARS, BRL, MXN
// frankfurter.app only covers ECB currencies (no COP, ARS, etc.)

const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const rateCache = {};

export async function getExchangeRate(from = 'USD', to = 'USD') {
  if (from === to) return 1;

  const cacheKey = `${from}-${to}`;
  const cached = rateCache[cacheKey];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.rate;
  }

  try {
    const res = await fetch(
      `https://open.er-api.com/v6/latest/${from}`,
      { next: { revalidate: 3600 } }
    );

    if (!res.ok) throw new Error('Exchange rate API error');

    const data = await res.json();
    const rate = data.rates?.[to];

    if (!rate) throw new Error(`No rate for ${to}`);

    rateCache[cacheKey] = { rate, timestamp: Date.now() };
    return rate;
  } catch (error) {
    console.error('Currency conversion error:', error.message);
    return 1; // fallback: show USD amount as-is
  }
}

export async function convertAmount(amount, targetCurrency, sourceCurrency = 'USD') {
  const src = (sourceCurrency || 'USD').toUpperCase();
  const tgt = (targetCurrency || 'USD').toUpperCase();

  if (src === tgt) {
    return { amount, currency: tgt, rate: 1, original: amount };
  }

  const rate = await getExchangeRate(src, tgt);
  const converted = Math.round(amount * rate * 100) / 100;

  return {
    amount: converted,
    currency: tgt,
    rate,
    original: amount,
  };
}

// Detect currency from country code (common mappings)
export function getCurrencyFromCountry(countryCode) {
  const map = {
    US: 'USD', CA: 'CAD', GB: 'GBP', EU: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR',
    PT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', IE: 'EUR', FI: 'EUR', GR: 'EUR',
    MX: 'MXN', CO: 'COP', AR: 'ARS', BR: 'BRL', CL: 'CLP', PE: 'PEN', UY: 'UYU',
    VE: 'VES', EC: 'USD', BO: 'BOB', PY: 'PYG', CR: 'CRC', PA: 'USD', DO: 'DOP',
    GT: 'GTQ', HN: 'HNL', SV: 'USD', NI: 'NIO', CU: 'CUP',
    JP: 'JPY', CN: 'CNY', KR: 'KRW', IN: 'INR', AU: 'AUD', NZ: 'NZD',
    TR: 'TRY', SA: 'SAR', AE: 'AED', EG: 'EGP', ZA: 'ZAR', NG: 'NGN',
    CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', RO: 'RON',
    HU: 'HUF', RU: 'RUB', UA: 'UAH', IL: 'ILS', PH: 'PHP', TH: 'THB', MY: 'MYR',
    SG: 'SGD', ID: 'IDR', VN: 'VND', PK: 'PKR', BD: 'BDT',
  };

  return map[countryCode?.toUpperCase()] || 'USD';
}

// Get all supported currencies for display
export const SUPPORTED_CURRENCIES = [
  { code: 'USD', symbol: '$', name: 'Dolar estadounidense' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'GBP', symbol: '£', name: 'Libra esterlina' },
  { code: 'MXN', symbol: '$', name: 'Peso mexicano' },
  { code: 'COP', symbol: '$', name: 'Peso colombiano' },
  { code: 'ARS', symbol: '$', name: 'Peso argentino' },
  { code: 'BRL', symbol: 'R$', name: 'Real brasileno' },
  { code: 'CLP', symbol: '$', name: 'Peso chileno' },
  { code: 'PEN', symbol: 'S/', name: 'Sol peruano' },
  { code: 'CAD', symbol: 'CA$', name: 'Dolar canadiense' },
  { code: 'AUD', symbol: 'A$', name: 'Dolar australiano' },
  { code: 'TRY', symbol: '₺', name: 'Lira turca' },
  { code: 'SAR', symbol: '﷼', name: 'Riyal saudi' },
];
