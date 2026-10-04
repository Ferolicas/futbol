import { isCronAuthorized } from '../../../../lib/internal-auth';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' };

// Compatibilidad fail-safe con versiones anteriores del workflow diario.
// Los resultados de Telegram ya no nacen de combinada_dia: el canal Premium
// usa /api/cron/telegram-premium-results y su snapshot de envíos confirmados.
export async function GET(request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }
  return Response.json({ ok: true, event: null, deprecated: true }, { headers: NO_STORE });
}

export async function POST(request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }
  return Response.json({ ok: true, deprecated: true }, { headers: NO_STORE });
}
