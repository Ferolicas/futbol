// ────────────────────────────────────────────────────────────────────────────
// env-bootstrap.ts — Carga .env ANTES que cualquier otro módulo del worker.
//
// PROBLEMA QUE RESUELVE:
// El worker se arranca con pm2 desde su propio cwd (/apps/futbol/apps/
// cfanalisis-worker), pero el .env con DATABASE_URL/VAPID_*/FOOTBALL_API_KEY
// está en el repo raíz (/apps/futbol/.env). `import 'dotenv/config'` usa el
// cwd → no encuentra ese .env y libs como lib/db.js crashean con
// "DATABASE_URL is not set" al evaluar sus imports estáticos.
//
// IMPORTANTE — orden de ejecución en ESM:
// En ESM, TODOS los `import` se resuelven y ejecutan ANTES que cualquier
// código top-level del módulo importador. Por eso poner `dotenvConfig()` en
// el cuerpo de index.ts después de los imports NO funciona: db.js ya leyó
// process.env.DATABASE_URL = undefined. La solución es hacer la carga del
// .env DENTRO de un módulo que se importe PRIMERO. Este archivo es ese
// módulo: solo tiene side-effects (mutar process.env), sin exports.
//
// El consumidor lo importa en la línea 1 de index.ts:
//   import './env-bootstrap.js';
// y solo DESPUÉS importa todo lo demás.
// ────────────────────────────────────────────────────────────────────────────

import { config as dotenvConfig } from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolución de rutas — funciona en AMBOS modos de arranque del worker:
//   tsx src/index.ts        → __dirname = /apps/futbol/apps/cfanalisis-worker/src
//   node dist/index.js      → __dirname = /apps/futbol/apps/cfanalisis-worker/dist
// En ambos casos:
//   - workerRoot = un nivel arriba (= apps/cfanalisis-worker)
//   - repoRoot   = tres niveles arriba (= apps/futbol)
// (En el commit anterior puse 4 niveles para repoRoot, lo que apuntaba a
// /apps/ — fuera del repo — y el .env no se cargaba. Fix: bajar a 3.)
const workerRoot = resolve(__dirname, '..');
const repoRoot   = resolve(__dirname, '..', '..', '..');

// Orden de carga: REPO RAÍZ primero (fuente principal), luego el .env local
// del worker SOBREESCRIBIENDO si existe (permite overrides puntuales en
// desarrollo sin tocar el .env del repo). `override: true` en la segunda
// llamada lo asegura — al revés que el commit anterior, donde el orden
// estaba invertido y un .env local viejo podía pisar al del repo.
const repoEnv   = resolve(repoRoot,   '.env');
const workerEnv = resolve(workerRoot, '.env');

const loaded = [];
if (existsSync(repoEnv))   { dotenvConfig({ path: repoEnv   });                    loaded.push(repoEnv); }
if (existsSync(workerEnv)) { dotenvConfig({ path: workerEnv, override: true });    loaded.push(workerEnv); }

// Diagnóstico inmediato (antes de cualquier logger; usamos console para que
// salga aunque el logger fallara). Sale en pm2 logs justo al arrancar.
// eslint-disable-next-line no-console
console.log('[env-bootstrap]', {
  cwd: process.cwd(),
  workerRoot,
  repoRoot,
  loaded,
  DATABASE_URL:      process.env.DATABASE_URL      ? 'set' : 'MISSING',
  VAPID_PUBLIC_KEY:  process.env.VAPID_PUBLIC_KEY  ? `len=${process.env.VAPID_PUBLIC_KEY.length}`  : 'MISSING',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY ? `len=${process.env.VAPID_PRIVATE_KEY.length}` : 'MISSING',
  FOOTBALL_API_KEY:  process.env.FOOTBALL_API_KEY  ? 'set' : 'MISSING',
  REDIS_HOST:        process.env.REDIS_HOST        ? 'set' : 'MISSING',
});

// Fail-fast: si lo crítico falta, mata el proceso AQUÍ con un mensaje claro
// en vez de dejar que crashee 200ms después en db.js con un stack confuso.
if (!process.env.DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.error(
    '[env-bootstrap] DATABASE_URL no está definida. ' +
    `Se intentó cargar de: ${loaded.join(', ') || '(ninguno encontrado)'}. ` +
    `Confirma que existe ${repoEnv} y contiene DATABASE_URL.`,
  );
  process.exit(1);
}
