/* eslint-disable */
/**
 * scripts/reanalyze-today-v8.js
 *
 * Re-analiza los partidos del dia tras subir cache_version 7 → 8.
 * Los analisis viejos NO tienen los mercados nuevos (shots, fouls,
 * halfGoals, halfWinner, asianHandicap, mostCorners, mostShots, mostFouls),
 * y el modelo descarta cualquier cache_version < 8 silenciosamente, asi
 * que la primera lectura tras el deploy ya dispara reanalisis. Pero si
 * quieres forzar el repintado del dashboard sin esperar al hit, corre esto.
 *
 * USO:
 *   node scripts/reanalyze-today-v8.js                # solo hoy (UTC)
 *   node scripts/reanalyze-today-v8.js 2026-05-15     # fecha concreta
 *
 * Internamente enqueue un job `futbol-analyze-all-today` en el worker via
 * /api/cron/analyze-all-today con force=true. El worker re-analiza
 * partido a partido respetando el rate limiter de API-Football.
 *
 * Variables de entorno (.env.local):
 *   NEXT_PUBLIC_APP_URL   ej https://cfanalisis.com
 *   CRON_SECRET           para autenticar el cron
 */

require('dotenv').config({ path: '.env.local' });

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || '').replace(/\/$/, '');
const SECRET = process.env.CRON_SECRET;

if (!APP_URL || !SECRET) {
  console.error('[reanalyze-v8] falta NEXT_PUBLIC_APP_URL o CRON_SECRET en .env.local');
  process.exit(1);
}

const date = process.argv[2] || new Date().toISOString().split('T')[0];
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`[reanalyze-v8] fecha invalida: ${date}`);
  process.exit(2);
}

(async () => {
  console.log(`[reanalyze-v8] enqueueing analyze-all-today date=${date} force=true...`);

  const url = `${APP_URL}/api/cron/analyze-all-today?secret=${encodeURIComponent(SECRET)}&date=${date}&force=true`;
  const res = await fetch(url, { method: 'POST' });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }

  if (!res.ok) {
    console.error(`[reanalyze-v8] FAIL status=${res.status}`, body);
    process.exit(1);
  }

  console.log(`[reanalyze-v8] enqueued OK:`, body);
  console.log('[reanalyze-v8] follow progress in /ferney or `pm2 logs cfanalisis-worker`.');
})().catch(e => {
  console.error('[reanalyze-v8] FATAL:', e.message);
  process.exit(1);
});
