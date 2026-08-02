import { listSportFixtures } from '../../../../../lib/multisport-analysis';
import { getMultisportConfig, getSportCompetitions, isIsoDate } from '../../../../../lib/multisport-config';
import { getCurrentUser } from '../../../../../lib/auth-pg';
import { userHasActivePlan } from '../../../../../lib/require-active-plan';
import { jsonError } from '../../../../../lib/api-error';

export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!(await userHasActivePlan(user))) return Response.json({ error: 'Subscription required' }, { status: 403 });
    const config = getMultisportConfig(params.sport);
    if (config.key === 'baseball') return Response.json({ error: 'Use /api/baseball/fixtures' }, { status: 400 });
    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date') || new Date().toISOString().slice(0, 10);
    if (!isIsoDate(date)) return Response.json({ error: 'Invalid date' }, { status: 400 });
    const timeZone = searchParams.get('tz') || 'UTC';
    const competitions = getSportCompetitions(config.key);
    const requested = searchParams.getAll('competition')
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean);
    const allowed = new Set(competitions.flatMap((competition) => [competition.key, String(competition.id)]));
    const competitionKeys = requested.filter((value) => allowed.has(value));
    // La experiencia del cliente es cache/DB-only. Los schedulers del worker
    // preparan calendarios y live; una visita nunca debe esperar 4-7 segundos
    // a tres dias de proveedores porque una liga este fuera de temporada.
    const fixtures = await listSportFixtures(config.key, date, {
      timeZone,
      competitionKeys,
      allowProviderFetch: false,
    });
    return Response.json({
      success: true,
      sport: config.key,
      date,
      timeZone,
      fixtures,
      count: fixtures.length,
      competitions: competitions.map(({ id, key, name, country }) => ({ id, key, name, country })),
    });
  } catch (error) {
    console.error('[api/sports/fixtures]', error.message);
    return jsonError(error);
  }
}
