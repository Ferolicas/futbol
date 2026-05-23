/**
 * GET /api/pick-image
 *
 * Genera dinamicamente una imagen PNG VERTICAL 800x1422 (ratio 9:16) del
 * "pick del dia". Ideal para Instagram/TikTok Stories, Reels, WhatsApp
 * Status. Layout single-column con secciones fluidas (sin split rigido).
 *
 * Query params:
 *   ?home=...&away=...
 *   &homeLogo=https://media.api-sports.io/football/teams/541.png
 *   &awayLogo=https://media.api-sports.io/football/teams/531.png
 *   &leagueLogo=https://media.api-sports.io/football/leagues/140.png
 *   &league=La Liga
 *   &pick=Mas de 2.5 goles
 *   &prob=85
 *   &odd=1.85
 *   &fecha=23 Mayo 2026
 *   &hora=14:30
 *   &analysis=Texto del analisis IA (opcional)
 *
 * Pre-requisito: public/fonts/Inter-Bold.ttf
 * Runtime: nodejs.
 */

import satori from 'satori';
import sharp from 'sharp';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const runtime = 'nodejs';

const W = 800;
const H = 1422;

async function toBase64(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
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
          width: '130px', height: '130px', borderRadius: '24px',
          background: bgColor, border: `2px solid ${accentColor}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        },
        children: [{ type: 'img', props: { src: logoB64, width: 100, height: 100, style: { objectFit: 'contain' } } }],
      },
    };
  }
  return {
    type: 'div', props: {
      style: {
        width: '130px', height: '130px', borderRadius: '24px',
        background: bgColor, border: `2px solid ${accentColor}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      },
      children: [{ type: 'span', props: { style: { color: accentColor, fontSize: '38px', fontWeight: 'bold' }, children: initials(name) } }],
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
        JSON.stringify({ error: `Font missing at ${fontPath}` }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const fontData = readFileSync(fontPath);

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

    const [homeB64, awayB64, leagueB64] = await Promise.all([
      homeLogo   ? toBase64(homeLogo)   : Promise.resolve(null),
      awayLogo   ? toBase64(awayLogo)   : Promise.resolve(null),
      leagueLogo ? toBase64(leagueLogo) : Promise.resolve(null),
    ]);

    const filled = Math.min(10, Math.round(Number(prob) / 10));
    const probBar = '█'.repeat(filled) + '░'.repeat(10 - filled);

    const svg = await satori(
      {
        type: 'div',
        props: {
          style: {
            width: `${W}px`, height: `${H}px`,
            background: 'linear-gradient(180deg, #04040e 0%, #080f22 50%, #04040e 100%)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center',
            fontFamily: 'Inter',
            padding: '44px 40px 32px 40px',
            gap: '0px',
          },
          children: [

            // ── CF LOGO ──
            {
              type: 'div', props: {
                style: { display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', marginBottom: '28px' },
                children: [
                  cfLogo
                    ? { type: 'img', props: { src: cfLogo, width: 300, height: 150, style: { objectFit: 'contain' } } }
                    : { type: 'span', props: { style: { color: '#00d4ff', fontSize: '48px', fontWeight: 'bold', letterSpacing: '6px' }, children: 'CF ANALISIS' } },
                ],
              },
            },

            // ── DIVIDER ──
            { type: 'div', props: { style: { height: '1px', width: '100%', background: 'linear-gradient(90deg, transparent, #00d4ff50, transparent)', marginBottom: '36px' } } },

            // ── ESCUDOS ──
            {
              type: 'div', props: {
                style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: '32px' },
                children: [
                  // Home
                  {
                    type: 'div', props: {
                      style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', flex: '1' },
                      children: [
                        badge(homeB64, home, '#00d4ff', 'rgba(0,212,255,0.10)'),
                        { type: 'span', props: { style: { color: '#ffffff', fontSize: '16px', textAlign: 'center', maxWidth: '140px', fontWeight: 'bold' }, children: home } },
                      ],
                    },
                  },
                  // Centro
                  {
                    type: 'div', props: {
                      style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', flex: '1' },
                      children: [
                        leagueB64
                          ? { type: 'img', props: { src: leagueB64, width: 40, height: 40, style: { objectFit: 'contain' } } }
                          : null,
                        { type: 'span', props: { style: { color: '#ffffff40', fontSize: '22px', fontWeight: 'bold', letterSpacing: '3px' }, children: 'VS' } },
                        fecha ? { type: 'span', props: { style: { color: '#ffffff', fontSize: '22px', fontWeight: 'bold' }, children: fecha } } : null,
                        hora  ? { type: 'span', props: { style: { color: '#00d4ff', fontSize: '26px', fontWeight: 'bold' }, children: hora } } : null,
                        { type: 'span', props: { style: { color: '#ffffff', fontSize: '18px', textAlign: 'center', maxWidth: '130px' }, children: league.toUpperCase() } },
                      ].filter(Boolean),
                    },
                  },
                  // Away
                  {
                    type: 'div', props: {
                      style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', flex: '1' },
                      children: [
                        badge(awayB64, away, '#a78bfa', 'rgba(167,139,250,0.10)'),
                        { type: 'span', props: { style: { color: '#ffffff', fontSize: '16px', textAlign: 'center', maxWidth: '140px', fontWeight: 'bold' }, children: away } },
                      ],
                    },
                  },
                ],
              },
            },

            // ── TARJETA CUOTA + PROB ──
            {
              type: 'div', props: {
                style: {
                  width: '100%',
                  background: 'linear-gradient(135deg, rgba(0,212,255,0.08), rgba(124,58,237,0.08))',
                  border: '1px solid rgba(0,212,255,0.25)',
                  borderRadius: '20px',
                  padding: '28px 32px',
                  display: 'flex',
                  justifyContent: 'space-around',
                  alignItems: 'center',
                  marginBottom: '32px',
                },
                children: [
                  {
                    type: 'div', props: {
                      style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' },
                      children: [
                        { type: 'span', props: { style: { color: '#ffffff', fontSize: '14px', letterSpacing: '4px' }, children: 'CUOTA' } },
                        { type: 'span', props: { style: { color: '#f59e0b', fontSize: '60px', fontWeight: 'bold' }, children: `${odd}x` } },
                      ],
                    },
                  },
                  { type: 'div', props: { style: { width: '1px', height: '70px', background: 'rgba(255,255,255,0.12)' } } },
                  {
                    type: 'div', props: {
                      style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' },
                      children: [
                        { type: 'span', props: { style: { color: '#ffffff', fontSize: '14px', letterSpacing: '4px' }, children: 'PROBABILIDAD' } },
                        { type: 'span', props: { style: { color: '#00d4ff', fontSize: '60px', fontWeight: 'bold' }, children: `${prob}%` } },
                        { type: 'span', props: { style: { color: '#00d4ff40', fontSize: '14px', letterSpacing: '3px' }, children: probBar } },
                      ],
                    },
                  },
                ],
              },
            },

            // ── APUESTA ──
            {
              type: 'div', props: {
                style: { width: '100%', display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '36px' },
                children: [
                  { type: 'span', props: { style: { color: '#ffffff', fontSize: '14px', letterSpacing: '4px' }, children: '✅  APUESTA' } },
                  { type: 'span', props: { style: { color: '#ffffff', fontSize: '40px', fontWeight: 'bold', lineHeight: '1.2' }, children: pick } },
                ],
              },
            },

            // ── DIVIDER ──
            { type: 'div', props: { style: { height: '1px', width: '100%', background: 'rgba(0,212,255,0.20)', marginBottom: '28px' } } },

            // ── ANALISIS IA ──
            {
              type: 'div', props: {
                style: { width: '100%', display: 'flex', flexDirection: 'column', gap: '16px', flex: '1' },
                children: [
                  {
                    type: 'div', props: {
                      style: { display: 'flex', alignItems: 'center', gap: '12px' },
                      children: [
                        { type: 'span', props: { style: { color: '#00d4ff', fontSize: '22px', fontWeight: 'bold', letterSpacing: '4px' }, children: 'ANALISIS IA' } },
                        { type: 'div', props: { style: { flex: '1', height: '1px', background: 'rgba(0,212,255,0.25)' } } },
                      ],
                    },
                  },
                  {
                    type: 'span', props: {
                      style: { color: '#ffffff', fontSize: '22px', lineHeight: '1.75', flex: '1' },
                      children: analysis || 'Analisis no disponible.',
                    },
                  },
                ],
              },
            },

            // ── FOOTER ──
            {
              type: 'div', props: {
                style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', paddingTop: '20px', borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: 'auto' },
                children: [
                  { type: 'span', props: { style: { color: '#ffffff30', fontSize: '13px' }, children: 'Juega con responsabilidad' } },
                  { type: 'span', props: { style: { color: '#00d4ff', fontSize: '16px', fontWeight: 'bold' }, children: 'cfanalisis.com' } },
                ],
              },
            },

          ],
        },
      },
      { width: W, height: H, fonts: [{ name: 'Inter', data: fontData, weight: 700, style: 'normal' }] }
    );

    const png = await sharp(Buffer.from(svg))
      .png({ quality: 100, compressionLevel: 3 })
      .toBuffer();

    return new Response(png, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
    });

  } catch (err) {
    console.error('[pick-image]', err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
