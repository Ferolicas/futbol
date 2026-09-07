/**
 * Job: baseball-cleanup
 * Port of /api/cron/baseball/cleanup. Deletes baseball cache rows older
 * than retention windows.
 *
 * Payload: {}
 */
import { supabaseAdmin } from '../../shared.js';

const cutoff = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
};

export async function runBaseballCleanup(_payload = {}) {
  const fixturesCutoff = cutoff(7);
  const a = await supabaseAdmin
    .from('baseball_fixtures_cache')
    .delete()
    .lt('date', fixturesCutoff);

  // Análisis y resultados son evidencia histórica del motor empírico. Antes se
  // eliminaban a los 30/60 días, reduciendo cada mes el dataset de validación.
  // Solo se purga la caché regenerable; los hechos durables se conservan.
  return { ok: true, deleted: { fixtures: a.count, analysis: 0, results: 0 } };
}
