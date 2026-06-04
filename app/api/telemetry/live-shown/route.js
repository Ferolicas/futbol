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

export const dynamic = 'force-dynamic';

const TTL = 48 * 3600;
const utcToday = () => new Date().toISOString().split('T')[0];

export async function POST(request) {
  try {
    const body = await request.json().catch(() => null);
    const fid = Number(body?.fid);
    const minute = body?.minute != null ? String(body.minute) : null;
    const shownAt = typeof body?.shownAt === 'string' ? body.shownAt : new Date().toISOString();
    if (!fid || minute == null) {
      return Response.json({ ok: false, error: 'fid y minute requeridos' }, { status: 400 });
    }

    const key = `eventlog:shown:${utcToday()}`;
    const map = (await redisGet(key)) || {};
    const k = `${fid}:${minute}`;
    // Conservar el más temprano (primer dispositivo que lo mostró).
    if (!map[k] || shownAt < map[k]) map[k] = shownAt;
    await redisSet(key, map, TTL);

    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
