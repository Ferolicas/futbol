// NT2 FIX: telemetría detección→pantalla. El Service Worker llama aquí cuando
// PINTA una notificación de evento en vivo (push). Registramos la hora `tShown`
// para que el /admin/eventlog del worker pueda calcular la latencia real
// "gol detectado → visto en pantalla". Antes el event-log prometía `tShown` pero
// NINGÚN cliente lo reportaba (endpoint inexistente) → la métrica era null.
//
// Clave Redis: `eventlog:shown:{date}` = mapa { "<fid>:<minuto>": shownAtISO }.
// Guardamos el MÁS TEMPRANO (el primer dispositivo que lo mostró = latencia real).
import { redisGet, redisSet } from '../../../../lib/redis';
import { jsonError } from '../../../../lib/api-error';
import { redisRateLimit, clientIp } from '../../../../lib/ratelimit-redis';
import { verifyLiveTelemetryToken } from '../../../../lib/live-telemetry-token';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const TTL = 48 * 3600;
const utcToday = () => new Date().toISOString().split('T')[0];
const bodySchema = z.object({
  fid: z.coerce.number().int().positive().max(2_147_483_647),
  minute: z.union([z.number().int().min(0).max(180), z.string().regex(/^\d{1,3}(?:\+\d{1,2})?$/)]),
  token: z.string().min(32).max(128),
  expiresAt: z.coerce.number().int().positive(),
});

export async function POST(request) {
  try {
    const limit = await redisRateLimit('live-telemetry', clientIp(request), 60, 60, { failClosed: true });
    if (!limit.success) {
      return Response.json({ ok: false, error: 'Too many requests' }, { status: limit.available ? 429 : 503 });
    }
    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'Invalid payload' }, { status: 400 });
    }
    const { fid, token, expiresAt } = parsed.data;
    const minute = String(parsed.data.minute);
    if (!verifyLiveTelemetryToken(fid, minute, expiresAt, token)) {
      return Response.json({ ok: false, error: 'Invalid token' }, { status: 401 });
    }
    const shownAt = new Date().toISOString();

    const key = `eventlog:shown:${utcToday()}`;
    const stored = await redisGet(key);
    const map = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    const k = `${fid}:${minute}`;
    // Conservar el más temprano (primer dispositivo que lo mostró).
    if (!map[k] || shownAt < map[k]) map[k] = shownAt;
    const entries = Object.entries(map);
    const bounded = entries.length > 5000
      ? Object.fromEntries(entries.slice(-4999))
      : map;
    bounded[k] = map[k];
    await redisSet(key, bounded, TTL);

    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
