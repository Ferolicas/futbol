import { convertAmount, getCurrencyFromCountry, SUPPORTED_CURRENCIES } from '../../../lib/currency';
import { PLANS } from '../../../lib/stripe';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const country = searchParams.get('country');
  const currency = searchParams.get('currency');

  const targetCurrency = currency || (country ? getCurrencyFromCountry(country) : 'USD');

  try {
    // Convert both plan prices
    const [plat1, plat2, ases1, ases2, ases3] = await Promise.all([
      convertAmount(PLANS.plataforma.firstMonthPrice / 100, targetCurrency),
      convertAmount(PLANS.plataforma.regularPrice / 100, targetCurrency),
      convertAmount(PLANS.asesoria.initialPrice / 100, targetCurrency),
      convertAmount(PLANS.asesoria.secondMonthPrice / 100, targetCurrency),
      convertAmount(PLANS.asesoria.regularPrice / 100, targetCurrency),
    ]);

    return Response.json({
      currency: targetCurrency,
      rate: plat1.rate,
      plans: {
        plataforma: {
          firstMonth: { usd: 15, local: plat1.amount, currency: targetCurrency },
          regular: { usd: 30, local: plat2.amount, currency: targetCurrency },
        },
        asesoria: {
          initial: { usd: 100, local: ases1.amount, currency: targetCurrency },
          secondMonth: { usd: 15, local: ases2.amount, currency: targetCurrency },
          regular: { usd: 30, local: ases3.amount, currency: targetCurrency },
        },
      },
      supportedCurrencies: SUPPORTED_CURRENCIES,
    });
  } catch (error) {
    console.error('Currency API error:', error);
    return Response.json({ error: 'Failed to get exchange rates' }, { status: 500 });
  }
}
