// Almacén PERMANENTE en disco para las fotos de jugadores de API-Football.
//
// Indexado por playerId (no por equipo): la foto de un jugador es la misma todo
// el año aunque se transfiera de club, así que se reutiliza toda la temporada.
//
// Jerarquía: RAM (L1, hot, por-proceso) → disco (L2, permanente, compartido) →
// api-sports (origen, una sola vez en la vida del jugador).
//
// El disco apunta al `public/` real del VPS (/apps/futbol/public/player-photos),
// que Caddy sirve estático y que SOBREVIVE a todos los deploys: `git reset --hard`
// y `git checkout -- public/` no borran archivos no rastreados
// (ver .github/workflows/deploy.yml). En local cae a <cwd>/public/player-photos.
//
// Lo usan: la ruta /api/player-photo/[id] (servir) y el cron de alineaciones
// (warm a T-45min: pre-descarga titulares+suplentes para que un gol en vivo
// muestre la foto al instante).

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';

export const PHOTO_DIR = process.env.PLAYER_PHOTO_DIR
  || (existsSync('/apps/futbol/public')
        ? '/apps/futbol/public/player-photos'
        : path.join(process.cwd(), 'public', 'player-photos'));

const ORIGIN = (id) => `https://media.api-sports.io/football/players/${id}.png`;
const MAX_RAM_ENTRIES = 800;          // cache caliente por-proceso (disco es la fuente permanente)
const NEG_TTL_MS = 6 * 3600 * 1000;   // recuerda 404 (id sin foto) 6h EN RAM (no en disco) → reintenta luego

const ram = new Map();                // id → { body:Buffer }
const neg = new Map();                // id → exp (negativos, solo RAM)

let dirReady = null;
function ensureDir() {
  if (!dirReady) dirReady = fs.mkdir(PHOTO_DIR, { recursive: true }).catch(() => {});
  return dirReady;
}

const cleanId = (id) => String(id ?? '').replace(/[^0-9]/g, '');
const filePng = (id) => path.join(PHOTO_DIR, `${id}.png`);

function ramSet(id, val) {
  ram.set(id, val);
  if (ram.size > MAX_RAM_ENTRIES) ram.delete(ram.keys().next().value);
}

async function fetchFromOrigin(id) {
  try {
    const res = await fetch(ORIGIN(id), { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null; // fallo de red transitorio
  }
}

async function writeAtomic(id, body) {
  await ensureDir();
  const tmp = path.join(PHOTO_DIR, `.${id}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, filePng(id)); // atómico en el mismo FS → nunca se sirve a medias
  } catch {
    try { await fs.unlink(tmp); } catch {}
  }
}

/**
 * Devuelve { body:Buffer } o null. RAM → disco → origen (y persiste a disco).
 */
export async function getPlayerPhoto(rawId) {
  const id = cleanId(rawId);
  if (!id) return null;

  const hot = ram.get(id);
  if (hot) { ram.delete(id); ram.set(id, hot); return hot; } // LRU touch

  const negExp = neg.get(id);
  if (negExp) {
    if (Date.now() < negExp) return null;
    neg.delete(id);
  }

  // Disco permanente
  try {
    const body = await fs.readFile(filePng(id));
    ramSet(id, { body });
    return { body };
  } catch { /* ENOENT → origen */ }

  const body = await fetchFromOrigin(id);
  if (!body) { neg.set(id, Date.now() + NEG_TTL_MS); return null; }
  ramSet(id, { body });
  writeAtomic(id, body); // fire-and-forget: persistir sin bloquear la respuesta
  return { body };
}

/**
 * Pre-calienta a DISCO una lista de playerIds (alineaciones T-45min). Solo
 * descarga los que faltan; concurrencia limitada para no saturar api-sports.
 * Fire-and-forget desde el caller. Devuelve { total, warmed }.
 */
export async function warmPlayerPhotos(ids, { concurrency = 4 } = {}) {
  const unique = [...new Set((ids || []).map(cleanId).filter(Boolean))];
  if (unique.length === 0) return { total: 0, warmed: 0 };
  await ensureDir();

  let cursor = 0, warmed = 0;
  async function lane() {
    while (cursor < unique.length) {
      const id = unique[cursor++];
      try {
        await fs.access(filePng(id)); // ya en disco → skip
        continue;
      } catch { /* falta → descargar */ }
      const body = await fetchFromOrigin(id);
      if (body) { await writeAtomic(id, body); warmed++; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, lane));
  return { total: unique.length, warmed };
}
