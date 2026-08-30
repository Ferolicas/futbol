import { buildFootballFirstHalfCornersReport } from '../../../../lib/football-first-half-corners-report';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function verifyAuth(request) {
  const { searchParams } = new URL(request.url);
  const supplied = searchParams.get('secret')
    || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return !!process.env.CRON_SECRET && supplied === process.env.CRON_SECRET;
}

function bogotaToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

export async function GET(request) {
  if (!verifyAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || bogotaToday();
  try {
    const report = await buildFootballFirstHalfCornersReport(date);
    return new Response(report.content, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${report.filename}"`,
        'Cache-Control': 'no-store',
        'X-CF-Fixtures': String(report.fixtures),
        'X-CF-Teams-With-History': String(report.coveredTeams),
        'X-CF-First-Half-Rows': String(report.coveredMatches),
      },
    });
  } catch (error) {
    return Response.json({ error: error.message || 'No se pudo generar el informe' }, { status: 500 });
  }
}
