/**
 * GET /api/pick-image
 *
 * Genera dinamicamente una imagen PNG VERTICAL 800x1422 (ratio 9:16) del
 * "pick del dia". Formato ideal para Instagram/TikTok Stories, Reels,
 * WhatsApp Status. Layout:
 *   - 60% top (853px): logo CF + escudos equipos + tarjeta cuota/prob + pick
 *   - 40% bottom (569px): panel ANALYSIS IA + footer
 *
 * Query params:
 *   ?match=Equipo A vs Equipo B        (legacy, opcional si pasas home+away)
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
 *   &analysis=Texto del analisis IA (siempre se muestra el panel; si vacio,
 *             aparece "Analisis no disponible")
 *
 * Pre-requisito: public/fonts/Inter-Bold.ttf en disco.
 * Runtime: nodejs (sharp + satori).
 */

import satori from 'satori';
import sharp from 'sharp';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const runtime = 'nodejs';
// Cache 1h — la imagen es deterministica por params, n8n/Telegram pueden
// reusar la misma URL durante el dia sin re-generar.
export const revalidate = 3600;

const W = 800;
const H = 1422; // ratio 9:16 — stories/reels

async function toBase64(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const mime = res.headers.get('content-type') || 'image/png';
    return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
  } catch { return null; }
}

function initials(name) {
  if (!name) return '?';
  const w = name.trim().split(/\s+/);
  if (w.length === 1) return w[0].substring(0, 2).toUpperCase();
  return (w[0][0] + w[w.length - 1][0]).toUpperCase();
}

function badge(logoB64, name, accentColor, bgColor) {
  if (logoB64) {
    return {
      type: 'div', props: {
        style: {
          width: '120px', height: '120px', borderRadius: '24px',
          background: bgColor,
          border: `2px solid ${accentColor}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden',
        },
        children: [{ type: 'img', props: { src: logoB64, width: 90, height: 90, style: { objectFit: 'contain' } } }],
      },
    };
  }
  return {
    type: 'div', props: {
      style: {
        width: '120px', height: '120px', borderRadius: '24px',
        background: bgColor, border: `2px solid ${accentColor}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      },
      children: [{ type: 'span', props: { style: { color: accentColor, fontSize: '36px', fontWeight: 'bold' }, children: initials(name) } }],
    },
  };
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
    for (const p of [
      join(process.cwd(), 'public/vflogo.png'),
      join(process.cwd(), '../public/vflogo.png'),
    ]) {
      if (existsSync(p)) {
        cfLogo = `data:image/png;base64,${readFileSync(p).toString('base64')}`;
        break;
      }
    }

    // Logos de equipos + liga descargados en paralelo desde api-sports CDN.
    const [homeB64, awayB64, leagueB64] = await Promise.all([
      homeLogo   ? toBase64(homeLogo)   : Promise.resolve(null),
      awayLogo   ? toBase64(awayLogo)   : Promise.resolve(null),
      leagueLogo ? toBase64(leagueLogo) : Promise.resolve(null),
    ]);

    const filled = Math.min(10, Math.round(Number(prob) / 10));
    const probBar = '█'.repeat(filled) + '░'.repeat(10 - filled);

    // 60% top zone = 853px, 40% bottom = 569px
    const TOP_H = 853;
    const BOT_H = 569;

    const svg = await satori(
      {
        type: 'div',
        props: {
          style: {
            width: `${W}px`, height: `${H}px`,
            background: 'linear-gradient(180deg, #04040e 0%, #080f22 45%, #04040e 100%)',
            display: 'flex', flexDirection: 'column',
            fontFamily: 'Inter', overflow: 'hidden',
          },
          children: [

            // ═══════════════════════════════════════════
            // TOP 60% — logo + escudos + tarjeta + pick
            // ═══════════════════════════════════════════
            {
              type: 'div', props: {
                style: {
                  height: `${TOP_H}px`, width: '100%',
                  display: 'flex', flexDirection: 'column',
                  alignItems: 'center',
                  padding: '0 40px',
                  position: 'relative',
                },
                children: [

                  // ── CF LOGO ──
                  {
                    type: 'div', props: {
                      style: {
                        display: 'flex', flexDirection: 'column',
                        alignItems: 'center', justifyContent: 'center',
                        height: '180px', width: '100%',
                        paddingTop: '36px',
                      },
                      children: [
                        cfLogo ? {
                          type: 'img', props: {
                            src: cfLogo, width: 300, height: 150,
                            style: { objectFit: 'contain' },
                          },
                        } : {
                          type: 'div', props: {
                            style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' },
                            children: [
                              { type: 'span', props: { style: { color: '#00d4ff', fontSize: '42px', fontWeight: 'bold', letterSpacing: '6px' }, children: 'CF ANÁLISIS' } },
                              { type: 'span', props: { style: { color: '#ffffff30', fontSize: '14px', letterSpacing: '4px' }, children: 'PICK DEL DÍA' } },
                            ],
                          },
                        },
                      ],
                    },
                  },

                  // ── DIVIDER ──
                  { type: 'div', props: { style: { height: '1px', width: '100%', background: 'linear-gradient(90deg, transparent, #00d4ff40, transparent)', marginBottom: '32px' } } },

                  // ── ESCUDOS + INFO CENTRAL ──
                  {
                    type: 'div', props: {
                      style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: '28px' },
                      children: [
                        // Home
                        {
                          type: 'div', props: {
                            style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', flex: '1' },
                            children: [
                              badge(homeB64, home, '#00d4ff', 'rgba(0,212,255,0.08)'),
                              { type: 'span', props: { style: { color: '#ffffffcc', fontSize: '14px', textAlign: 'center', maxWidth: '140px', fontWeight: 'bold' }, children: home } },
                            ],
                          },
                        },
                        // Centro: liga + VS + fecha + hora
                        {
                          type: 'div', props: {
                            style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', flex: '1' },
                            children: [
                              leagueB64 ? { type: 'img', props: { src: leagueB64, width: 36, height: 36, style: { objectFit: 'contain' } } } : null,
                              { type: 'span', props: { style: { color: '#ffffff20', fontSize: '18px', fontWeight: 'bold', letterSpacing: '2px' }, children: 'VS' } },
                              fecha ? { type: 'span', props: { style: { color: '#ffffff50', fontSize: '12px', letterSpacing: '1px' }, children: fecha } } : null,
                              hora  ? { type: 'span', props: { style: { color: '#00d4ff80', fontSize: '14px' }, children: `🕐 ${hora}` } } : null,
                              { type: 'span', props: { style: { color: '#ffffff25', fontSize: '11px', letterSpacing: '1px', textAlign: 'center', maxWidth: '110px' }, children: league.toUpperCase() } },
                            ].filter(Boolean),
                          },
                        },
                        // Away
                        {
                          type: 'div', props: {
                            style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', flex: '1' },
                            children: [
                              badge(awayB64, away, '#a78bfa', 'rgba(167,139,250,0.08)'),
                              { type: 'span', props: { style: { color: '#ffffffcc', fontSize: '14px', textAlign: 'center', maxWidth: '140px', fontWeight: 'bold' }, children: away } },
                            ],
                          },
                        },
                      ],
                    },
                  },

                  // ── TARJETA CUOTA + PROBABILIDAD ──
                  {
                    type: 'div', props: {
                      style: {
                        width: '100%',
                        background: 'linear-gradient(135deg, rgba(0,212,255,0.07), rgba(124,58,237,0.07))',
                        border: '1px solid rgba(0,212,255,0.2)',
                        borderRadius: '20px',
                        padding: '24px 32px',
                        display: 'flex',
                        justifyContent: 'space-around',
                        alignItems: 'center',
                        marginBottom: '24px',
                      },
                      children: [
                        // Cuota
                        {
                          type: 'div', props: {
                            style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' },
                            children: [
                              { type: 'span', props: { style: { color: '#ffffff30', fontSize: '11px', letterSpacing: '3px' }, children: 'CUOTA' } },
                              { type: 'span', props: { style: { color: '#f59e0b', fontSize: '52px', fontWeight: 'bold' }, children: `${odd}x` } },
                            ],
                          },
                        },
                        // Separador
                        { type: 'div', props: { style: { width: '1px', height: '60px', background: 'rgba(255,255,255,0.1)' } } },
                        // Prob
                        {
                          type: 'div', props: {
                            style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' },
                            children: [
                              { type: 'span', props: { style: { color: '#ffffff30', fontSize: '11px', letterSpacing: '3px' }, children: 'PROBABILIDAD' } },
                              { type: 'span', props: { style: { color: '#00d4ff', fontSize: '52px', fontWeight: 'bold' }, children: `${prob}%` } },
                              { type: 'span', props: { style: { color: '#00d4ff30', fontSize: '12px', letterSpacing: '2px' }, children: probBar } },
                            ],
                          },
                        },
                      ],
                    },
                  },

                  // ── APUESTA (pick text) ──
                  {
                    type: 'div', props: {
                      style: { display: 'flex', alignItems: 'center', gap: '12px', width: '100%' },
                      children: [
                        { type: 'span', props: { style: { fontSize: '22px' }, children: '✅' } },
                        {
                          type: 'div', props: {
                            style: { display: 'flex', flexDirection: 'column', gap: '2px' },
                            children: [
                              { type: 'span', props: { style: { color: '#ffffff40', fontSize: '11px', letterSpacing: '3px' }, children: 'APUESTA' } },
                              { type: 'span', props: { style: { color: '#ffffff', fontSize: '20px', fontWeight: 'bold' }, children: pick } },
                            ],
                          },
                        },
                      ],
                    },
                  },

                ],
              },
            },

            // ═══════════════════════════════════════════
            // BOTTOM 40% — analisis IA
            // ═══════════════════════════════════════════
            {
              type: 'div', props: {
                style: {
                  height: `${BOT_H}px`, width: '100%',
                  display: 'flex', flexDirection: 'column',
                  padding: '28px 40px 36px 40px',
                  borderTop: '1px solid rgba(0,212,255,0.15)',
                  background: 'rgba(0,0,0,0.3)',
                },
                children: [
                  // Header analisis
                  {
                    type: 'div', props: {
                      style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' },
                      children: [
                        { type: 'span', props: { style: { fontSize: '18px' }, children: '🤖' } },
                        { type: 'span', props: { style: { color: '#00d4ff', fontSize: '12px', fontWeight: 'bold', letterSpacing: '3px' }, children: 'ANÁLISIS IA' } },
                        { type: 'div', props: { style: { flex: '1', height: '1px', background: 'rgba(0,212,255,0.2)', marginLeft: '8px' } } },
                      ],
                    },
                  },
                  // Texto analisis
                  {
                    type: 'div', props: {
                      style: {
                        flex: '1',
                        color: '#ffffffaa',
                        fontSize: '17px',
                        lineHeight: '1.7',
                        overflow: 'hidden',
                      },
                      children: analysis || 'Análisis no disponible.',
                    },
                  },
                  // Footer
                  {
                    type: 'div', props: {
                      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.06)' },
                      children: [
                        { type: 'span', props: { style: { color: '#ffffff15', fontSize: '11px' }, children: '⚠️ Juega con responsabilidad' } },
                        { type: 'span', props: { style: { color: '#00d4ff60', fontSize: '12px', fontWeight: 'bold', letterSpacing: '1px' }, children: 'cfanalisis.com' } },
                      ],
                    },
                  },
                ],
              },
            },

          ],
        },
      },
      { width: W, height: H, fonts: [{ name: 'Inter', data: fontData, weight: 700, style: 'normal' }] }
    );

    // Sharp con alta calidad — quality 100, compression 6 (sweet spot)
    const png = await sharp(Buffer.from(svg))
      .png({ quality: 100, compressionLevel: 6 })
      .toBuffer();

    return new Response(png, {
      headers: {
        'Content-Type': 'image/png',
        // No cache para iteracion rapida durante desarrollo de la imagen.
        // Cambia a 'public, max-age=3600' cuando estes feliz con el diseño.
        'Cache-Control': 'no-store',
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
