import crypto from 'node:crypto';
import { z } from 'zod';
import { getPublicPerformance } from '../../../../lib/public-performance';
import { redisGet, redisSet } from '../../../../lib/redis';
import { clientIp, redisRateLimit } from '../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

const schema = z.object({
  preset: z.enum(['all', 'day', 'week', 'fortnight', 'month', 'quarter', 'semester', 'year', 'custom']).default('all'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sport: z.enum(['football', 'baseball', 'basketball', 'american-football']).optional(),
  league: z.string().trim().max(120).optional(),
  market: z.string().trim().max(160).optional(),
  team: z.string().trim().max(120).optional(),
  q: z.string().trim().max(80).optional(),
  outcome: z.enum(['won', 'lost']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(6).max(24).default(12),
}).superRefine((value, context) => {
  if (value.preset === 'custom' && (!value.from || !value.to)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'El rango requiere fecha inicial y final' });
  }
  if (value.from && value.to && value.from > value.to) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'El rango de fechas no es válido' });
  }
});

const presetDays = { day: 1, week: 7, fortnight: 15, month: 30, quarter: 90, semester: 180, year: 365 };

function normalizedFilters(data) {
  let from = data.from || null;
  let to = data.to || null;
  if (data.preset !== 'custom' && data.preset !== 'all') {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - presetDays[data.preset] + 1);
    from = start.toISOString().slice(0, 10);
    to = new Date().toISOString().slice(0, 10);
  }
  return {
    from, to, sport: data.sport || null, query: data.q || '',
    league: data.league || '', market: data.market || '', team: data.team || '',
    outcome: data.outcome || null,
    page: data.page, pageSize: data.pageSize,
  };
}

export async function GET(request) {
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: 'Filtros no válidos' }, { status: 400 });
  const rate = await redisRateLimit('public-performance', clientIp(request), 60, 60, { failClosed: true });
  if (!rate.available) return Response.json({ error: 'Servicio temporalmente no disponible' }, { status: 503 });
  if (!rate.success) return Response.json({ error: 'Demasiadas consultas. Inténtalo en un minuto.' }, { status: 429, headers: { 'Retry-After': '60' } });
  const filters = normalizedFilters(parsed.data);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(filters)).digest('hex');
  const cacheKey = `public-performance:v2:${fingerprint}`;
  try {
    const cached = await redisGet(cacheKey);
    if (cached) return Response.json(cached, { headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300', 'X-Data-Cache': 'HIT' } });
    const performance = await getPublicPerformance(filters);
    const payload = { ...performance, filters: { preset: parsed.data.preset, from: filters.from, to: filters.to, sport: filters.sport, query: filters.query, outcome: filters.outcome }, updatedAt: new Date().toISOString() };
    await redisSet(cacheKey, payload, 300);
    return Response.json(payload, { headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300', 'X-Data-Cache': 'MISS' } });
  } catch (error) {
    console.error('[public-performance]', error?.message || 'unknown error');
    return Response.json({ error: 'No se pudo cargar el rendimiento' }, { status: 500 });
  }
}
