/**
 * GET /api/pick-image
 *
 * Genera dinamicamente una imagen PNG 800x460 (o 800x580 si incluye
 * analysis IA) del "pick del dia" usando satori + sharp.
 *
 * Query params:
 *   ?match=Equipo A vs Equipo B           (legacy, opcional si pasas home+away)
 *   &home=Equipo Local
 *   &away=Equipo Visitante
 *   &homeLogo=https://media.api-sports.io/football/teams/541.png
 *   &awayLogo=https://media.api-sports.io/football/teams/531.png
 *   &leagueLogo=https://media.api-sports.io/football/leagues/140.png
 *   &league=La Liga
 *   &pick=Mas de 2.5 goles
 *   &prob=85
 *   &odd=1.85
 *   &fecha=23 Mayo 2026
 *   &hora=14:30
 *   &analysis=Texto del analisis IA (opcional, expande la card a 580px)
 *
 * Logos se descargan en paralelo (timeout 4s) y se embeben como base64.
 * Si la descarga falla, fallback a circulo con iniciales del equipo.
 *
 * Pre-requisito: public/fonts/Inter-Bold.ttf en disco.
 *
 * Runtime: nodejs (sharp + satori requieren bindings nativos).
 */

import satori from 'satori';
import sharp from 'sharp';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const runtime = 'nodejs';
// Cache 1h en CDN — la imagen es deterministica por params; n8n y Telegram
// pueden hacer reusar la misma URL durante el dia.
export const revalidate = 3600;

function initials(name) {
  if (!name) return '??';
  const w = name.trim().split(/\s+/);
  if (w.length === 1) return w[0].substring(0, 2).toUpperCase();
  return (w[0][0] + w[w.length - 1][0]).toUpperCase();
}

// Descarga un asset y lo embebe como data URL. Timeout 4s para evitar que
// la imagen tarde demasiado si el CDN externo va lento. Si falla devuelve
// null → el badge cae a fallback con iniciales.
async function toBase64(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const mime = res.headers.get('content-type') || 'image/png';
    return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
  } catch { return null; }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const match      = searchParams.get('match')      || 'Partido del día';
    const pick       = searchParams.get('pick')       || '';
    const prob       = searchParams.get('prob')       || '0';
    const odd        = searchParams.get('odd')        || '0';
    const league     = searchParams.get('league')     || '';
    const fecha      = searchParams.get('fecha')      || '';
    const hora       = searchParams.get('hora')       || '';
    const analysis   = searchParams.get('analysis')   || '';
    const home       = searchParams.get('home')       || match.split(' vs ')[0] || '';
    const away       = searchParams.get('away')       || match.split(' vs ')[1] || '';
    const homeLogo   = searchParams.get('homeLogo')   || '';
    const awayLogo   = searchParams.get('awayLogo')   || '';
    const leagueLogo = searchParams.get('leagueLogo') || '';

    const fontPath = join(process.cwd(), 'public/fonts/Inter-Bold.ttf');
    if (!existsSync(fontPath)) {
      return new Response(
        JSON.stringify({
          error: `Font missing at ${fontPath}. Run on VPS: mkdir -p public/fonts && curl -L -o public/fonts/Inter-Bold.ttf https://github.com/rsms/inter/raw/master/docs/font-files/Inter-Bold.ttf`,
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const fontData = readFileSync(fontPath);

    // CF Logo — embebido como base64 directo desde public/
    let cfLogo = null;
    for (const p of [join(process.cwd(), 'public/vflogo.png'), join(process.cwd(), '../public/vflogo.png')]) {
      if (existsSync(p)) { cfLogo = `data:image/png;base64,${readFileSync(p).toString('base64')}`; break; }
    }

    // Logos de equipos + liga descargados en paralelo desde api-sports CDN.
    const [homeLogoB64, awayLogoB64, leagueLogoB64] = await Promise.all([
      homeLogo   ? toBase64(homeLogo)   : Promise.resolve(null),
      awayLogo   ? toBase64(awayLogo)   : Promise.resolve(null),
      leagueLogo ? toBase64(leagueLogo) : Promise.resolve(null),
    ]);

    const filled = Math.min(10, Math.round(Number(prob) / 10));
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const HEIGHT = analysis ? 580 : 460;

    // Helper: logo image (si tenemos base64) o circulo con iniciales
    function teamBadge(logoB64, name, color, borderColor) {
      if (logoB64) {
        return {
          type: 'div', props: {
            style: { width: '64px', height: '64px', borderRadius: '50%', background: '#0d1830', border: `2px solid ${borderColor}`, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
            children: [{ type: 'img', props: { src: logoB64, width: 48, height: 48, style: { objectFit: 'contain' } } }],
          },
        };
      }
      return {
        type: 'div', props: {
          style: { width: '64px', height: '64px', borderRadius: '50%', background: 'linear-gradient(135deg, #1a2a4e, #0d1428)', border: `2px solid ${borderColor}`, display: 'flex', alignItems: 'center', justifyContent: 'center' },
          children: [{ type: 'span', props: { style: { color, fontSize: '20px', fontWeight: 'bold' }, children: initials(name) } }],
        },
      };
    }

    const svg = await satori(
      {
        type: 'div',
        props: {
          style: {
            width: '800px', height: `${HEIGHT}px`,
            background: 'linear-gradient(160deg, #05050f 0%, #0b1830 55%, #05050f 100%)',
            display: 'flex', flexDirection: 'column',
            padding: '30px 36px', fontFamily: 'Inter',
          },
          children: [

            // ── HEADER ──
            {
              type: 'div', props: {
                style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' },
                children: [
                  {
                    type: 'div', props: {
                      style: { display: 'flex', alignItems: 'center', gap: '12px' },
                      children: [
                        cfLogo
                          ? { type: 'img', props: { src: cfLogo, width: 40, height: 40, style: { borderRadius: '10px', border: '1px solid #00d4ff30' } } }
                          : { type: 'span', props: { style: { fontSize: '30px' }, children: '🔥' } },
                        {
                          type: 'div', props: {
                            style: { display: 'flex', flexDirection: 'column', gap: '2px' },
                            children: [
                              { type: 'span', props: { style: { color: '#00d4ff', fontSize: '17px', fontWeight: 'bold', letterSpacing: '4px' }, children: 'CF ANÁLISIS' } },
                              { type: 'span', props: { style: { color: '#ffffff30', fontSize: '10px', letterSpacing: '3px' }, children: 'PICK DEL DÍA' } },
                            ],
                          },
                        },
                      ],
                    },
                  },
                  {
                    type: 'div', props: {
                      style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' },
                      children: [
                        { type: 'span', props: { style: { color: '#ffffffcc', fontSize: '14px', fontWeight: 'bold' }, children: fecha } },
                        { type: 'span', props: { style: { color: '#00d4ff70', fontSize: '12px' }, children: hora ? `🕐 ${hora} COL` : '' } },
                      ],
                    },
                  },
                ],
              },
            },

            // ── DIVIDER ──
            { type: 'div', props: { style: { height: '1px', background: 'linear-gradient(90deg, transparent, #00d4ff50, transparent)', marginBottom: '20px' } } },

            // ── EQUIPOS ──
            {
              type: 'div', props: {
                style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '20px', marginBottom: '18px' },
                children: [
                  // Local
                  {
                    type: 'div', props: {
                      style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', flex: '1' },
                      children: [
                        teamBadge(homeLogoB64, home, '#00d4ff', '#00d4ff40'),
                        { type: 'span', props: { style: { color: '#ffffffaa', fontSize: '12px', textAlign: 'center' }, children: home } },
                      ],
                    },
                  },
                  // Centro
                  {
                    type: 'div', props: {
                      style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' },
                      children: [
                        { type: 'span', props: { style: { color: '#ffffff20', fontSize: '22px', fontWeight: 'bold' }, children: 'VS' } },
                        {
                          type: 'div', props: {
                            style: { display: 'flex', alignItems: 'center', gap: '6px' },
                            children: [
                              leagueLogoB64 ? { type: 'img', props: { src: leagueLogoB64, width: 18, height: 18, style: { objectFit: 'contain' } } } : null,
                              { type: 'span', props: { style: { color: '#ffffff30', fontSize: '10px', letterSpacing: '1px', textAlign: 'center', maxWidth: '130px' }, children: league.toUpperCase() } },
                            ].filter(Boolean),
                          },
                        },
                      ],
                    },
                  },
                  // Visitante
                  {
                    type: 'div', props: {
                      style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', flex: '1' },
                      children: [
                        teamBadge(awayLogoB64, away, '#a78bfa', '#7c3aed40'),
                        { type: 'span', props: { style: { color: '#ffffffaa', fontSize: '12px', textAlign: 'center' }, children: away } },
                      ],
                    },
                  },
                ],
              },
            },

            // ── DIVIDER ──
            { type: 'div', props: { style: { height: '1px', background: '#ffffff0f', marginBottom: '16px' } } },

            // ── PICK + STATS ──
            {
              type: 'div', props: {
                style: { display: 'flex', gap: '12px', marginBottom: analysis ? '14px' : '0' },
                children: [
                  {
                    type: 'div', props: {
                      style: { flex: '1', background: '#00d4ff08', border: '1px solid #00d4ff20', borderRadius: '12px', padding: '16px 20px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '8px' },
                      children: [
                        { type: 'span', props: { style: { color: '#ffffff30', fontSize: '10px', letterSpacing: '3px' }, children: 'PRONÓSTICO' } },
                        { type: 'span', props: { style: { color: '#ffffff', fontSize: '16px', fontWeight: 'bold' }, children: `✅  ${pick}` } },
                      ],
                    },
                  },
                  {
                    type: 'div', props: {
                      style: { background: '#00d4ff08', border: '1px solid #00d4ff20', borderRadius: '12px', padding: '16px 18px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', minWidth: '108px' },
                      children: [
                        { type: 'span', props: { style: { color: '#ffffff30', fontSize: '10px', letterSpacing: '2px' }, children: 'PROB.' } },
                        { type: 'span', props: { style: { color: '#00d4ff', fontSize: '28px', fontWeight: 'bold' }, children: `${prob}%` } },
                        { type: 'span', props: { style: { color: '#00d4ff35', fontSize: '10px' }, children: bar } },
                      ],
                    },
                  },
                  {
                    type: 'div', props: {
                      style: { background: '#f59e0b08', border: '1px solid #f59e0b25', borderRadius: '12px', padding: '16px 18px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', minWidth: '108px' },
                      children: [
                        { type: 'span', props: { style: { color: '#ffffff30', fontSize: '10px', letterSpacing: '2px' }, children: 'CUOTA' } },
                        { type: 'span', props: { style: { color: '#f59e0b', fontSize: '28px', fontWeight: 'bold' }, children: `${odd}x` } },
                      ],
                    },
                  },
                ],
              },
            },

            // ── ANÁLISIS IA (opcional) ──
            ...(analysis ? [{
              type: 'div', props: {
                style: { background: '#ffffff04', borderLeft: '3px solid #00d4ff60', borderRadius: '0 10px 10px 0', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: '6px' },
                children: [
                  { type: 'span', props: { style: { color: '#00d4ff70', fontSize: '10px', letterSpacing: '2px', fontWeight: 'bold' }, children: '🤖  ANÁLISIS IA' } },
                  { type: 'span', props: { style: { color: '#ffffffbb', fontSize: '13px', lineHeight: '1.6' }, children: analysis } },
                ],
              },
            }] : []),

            // ── FOOTER ──
            {
              type: 'div', props: {
                style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto', paddingTop: '14px' },
                children: [
                  { type: 'span', props: { style: { color: '#ffffff18', fontSize: '11px' }, children: '⚠️ Juega con responsabilidad' } },
                  { type: 'span', props: { style: { color: '#00d4ff', fontSize: '14px', fontWeight: 'bold', letterSpacing: '1px' }, children: 'cfanalisis.com' } },
                ],
              },
            },

          ],
        },
      },
      { width: 800, height: HEIGHT, fonts: [{ name: 'Inter', data: fontData, weight: 700, style: 'normal' }] }
    );

    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    return new Response(png, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      },
    });

  } catch (err) {
    console.error('[pick-image]', err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
