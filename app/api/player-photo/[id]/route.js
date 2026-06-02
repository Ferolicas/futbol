// Proxy con caché para las fotos de jugadores de API-Football.
//
// PROBLEMA: media.api-sports.io es lento y no manda Cache-Control fuerte, así
// que el navegador re-descargaba la foto del goleador en cada vista → "se
// tardan mucho en cargar".
//
// SOLUCIÓN: servir la foto desde NUESTRO origen con:
//   - caché en memoria del server (LRU): la primera petición de un jugador hace
//     1 hop a api-sports.io; las siguientes (cualquier usuario) salen al instante
//     desde RAM del proceso web (pm2 fork = 1 instancia, persiste entre requests).
//   - Cache-Control inmutable 30d: el navegador la cachea y no la vuelve a pedir.
// Resultado: misma-origin (sin handshake a un tercero lento en cada carga) y
// prácticamente instantáneo tras la primera vez.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ENTRIES = 600;            // ~jugadores en caché (fotos ~10-30KB c/u)
const NEG_TTL_MS = 6 * 3600 * 1000; // recuerda 404 (id sin foto) 6h para no martillar
const cache = new Map();            // id → { body:Buffer|null, type, exp? }

function lruGet(id) {
  const v = cache.get(id);
  if (!v) return null;
  if (v.body === null && v.exp && Date.now() > v.exp) { cache.delete(id); return null; }
  cache.delete(id); cache.set(id, v); // refresca recencia (LRU)
  return v;
}
function lruSet(id, val) {
  cache.set(id, val);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

const IMMUTABLE = 'public, max-age=2592000, s-maxage=2592000, immutable';

export async function GET(_req, { params }) {
  const id = String(params?.id || '').replace(/[^0-9]/g, '');
  if (!id) return new Response(null, { status: 400 });

  const hit = lruGet(id);
  if (hit) {
    if (hit.body === null) return new Response(null, { status: 404, headers: { 'Cache-Control': 'public, max-age=86400' } });
    return new Response(hit.body, { status: 200, headers: { 'Content-Type': hit.type, 'Cache-Control': IMMUTABLE } });
  }

  try {
    const res = await fetch(`https://media.api-sports.io/football/players/${id}.png`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      lruSet(id, { body: null, exp: Date.now() + NEG_TTL_MS });
      return new Response(null, { status: 404, headers: { 'Cache-Control': 'public, max-age=86400' } });
    }
    const type = res.headers.get('content-type') || 'image/png';
    const body = Buffer.from(await res.arrayBuffer());
    lruSet(id, { body, type });
    return new Response(body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': IMMUTABLE } });
  } catch {
    // No cacheamos el fallo transitorio (red): el próximo intento reintenta.
    return new Response(null, { status: 502 });
  }
}
