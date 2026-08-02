import { redisMGet, KEYS } from '../../../lib/redis';
import { getCurrentUser } from '../../../lib/auth-pg';
import { jsonError } from '../../../lib/api-error';

// El navegador nunca consulta API-Football. El worker centralizado actualiza
// Redis cada 20 s, reconcilia vencidos por lotes y protege cuota/rate-limit de
// forma global. Así 100 clientes no disparan 100 recuperaciones idénticas.
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

async function readSnapshots(requestedDate) {
  const utcDate = new Date().toISOString().split('T')[0];
  const date = requestedDate || utcDate;
  const dates = [...new Set([utcDate, date])];
  const snapshots = await redisMGet(dates.map((item) => KEYS.liveStats(item)));
  const liveStats = {};
  snapshots.forEach((snapshot) => {
    if (snapshot && typeof snapshot === 'object') Object.assign(liveStats, snapshot);
  });
  return {
    utcDate,
    date,
    liveStats,
    viewDateLiveStats: date !== utcDate
      ? (snapshots[dates.indexOf(date)] || {})
      : null,
  };
}

async function requireUser() {
  return getCurrentUser();
}

export async function GET(request) {
  try {
    if (!(await requireUser())) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const requestedDate = new URL(request.url).searchParams.get('date');
    const data = await readSnapshots(requestedDate);
    return Response.json({
      success: true,
      liveStats: data.liveStats,
      viewDateLiveStats: data.viewDateLiveStats,
      source: 'worker-cache',
      timestamp: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

// Compatibilidad con clientes antiguos que enviaban POST. Sigue siendo una
// lectura cache-only; jamás gasta cuota ni inventa estados.
export async function POST(request) {
  try {
    if (!(await requireUser())) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    let body = {};
    try { body = await request.json(); } catch {}
    const data = await readSnapshots(body.date || null);
    return Response.json({
      success: true,
      skipped: true,
      reason: 'worker-cache',
      liveStats: data.liveStats,
      viewDateLiveStats: data.viewDateLiveStats,
      source: 'worker-cache',
      timestamp: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
