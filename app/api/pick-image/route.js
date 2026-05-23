/**
 * GET /api/pick-image
 *
 * Genera dinamicamente una imagen PNG 800x450 del "pick del dia" usando
 * satori (HTML/CSS → SVG) y sharp (SVG → PNG). Ideal para compartir en
 * Telegram, Twitter/X, WhatsApp, embeds, etc.
 *
 * Query params:
 *   ?match=Equipo+A+vs+Equipo+B
 *   &pick=Over+2.5+goles
 *   &prob=85
 *   &odd=1.85
 *   &league=Premier+League
 *   &fecha=23+Mayo+2026
 *
 * Pre-requisito: el archivo public/fonts/Inter-Bold.ttf debe existir.
 * Si falta, el endpoint devuelve 500 con instrucciones de descarga.
 *
 * Runtime: nodejs (NO edge — satori + sharp requieren Node nativos).
 */

import satori from 'satori';
import sharp from 'sharp';
import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const runtime = 'nodejs';
// Cache 1h en CDN (Caddy + browser). La misma URL con mismos params
// devuelve la misma imagen, asi que es altamente cacheable.
export const revalidate = 3600;

// Lazy-cached font buffer — leemos el TTF una sola vez por proceso.
let _fontCache = null;
function loadFont() {
  if (_fontCache) return _fontCache;
  const fontPath = join(process.cwd(), 'public/fonts/Inter-Bold.ttf');
  if (!existsSync(fontPath)) {
    throw new Error(
      `Font file missing at ${fontPath}. Run:\n` +
      `  mkdir -p public/fonts && curl -L -o public/fonts/Inter-Bold.ttf https://github.com/rsms/inter/raw/master/docs/font-files/Inter-Bold.ttf`
    );
  }
  _fontCache = readFileSync(fontPath);
  return _fontCache;
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const match  = searchParams.get('match')  || 'Equipo A vs Equipo B';
  const pick   = searchParams.get('pick')   || 'Sin pick';
  const prob   = searchParams.get('prob')   || '0';
  const odd    = searchParams.get('odd')    || '0.00';
  const league = searchParams.get('league') || 'Liga';
  const fecha  = searchParams.get('fecha')  || new Date().toLocaleDateString('es-CO');

  let fontData;
  try {
    fontData = loadFont();
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }

  const svg = await satori(
    {
      type: 'div',
      props: {
        style: {
          width: '800px',
          height: '450px',
          background: 'linear-gradient(135deg, #0a0a1a 0%, #0d1b3e 50%, #0a0a1a 100%)',
          display: 'flex',
          flexDirection: 'column',
          padding: '40px',
          fontFamily: 'Inter',
        },
        children: [
          // Header
          {
            type: 'div',
            props: {
              style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' },
              children: [
                { type: 'span', props: { style: { color: '#00d4ff', fontSize: '22px', fontWeight: 'bold', letterSpacing: '3px' }, children: '🔥 CF ANÁLISIS · PICK DEL DÍA' } },
                { type: 'span', props: { style: { color: '#ffffff90', fontSize: '15px', background: '#ffffff15', padding: '6px 14px', borderRadius: '20px' }, children: fecha } },
              ],
            },
          },
          // Divider
          { type: 'div', props: { style: { height: '1px', background: '#00d4ff40', marginBottom: '20px' } } },
          // Match
          { type: 'div', props: { style: { color: '#ffffff', fontSize: '24px', fontWeight: 'bold', marginBottom: '4px' }, children: `⚽ ${match}` } },
          { type: 'div', props: { style: { color: '#00d4ff80', fontSize: '14px', marginBottom: '24px' }, children: `🏆 ${league}` } },
          // Pick box
          {
            type: 'div',
            props: {
              style: {
                background: '#00d4ff10',
                border: '1px solid #00d4ff40',
                borderRadius: '12px',
                padding: '20px 24px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 'auto',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: { display: 'flex', flexDirection: 'column', gap: '6px' },
                    children: [
                      { type: 'span', props: { style: { color: '#ffffff50', fontSize: '11px', letterSpacing: '2px' }, children: 'PRONÓSTICO' } },
                      { type: 'span', props: { style: { color: '#ffffff', fontSize: '20px', fontWeight: 'bold' }, children: `✅ ${pick}` } },
                    ],
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: { display: 'flex', gap: '32px' },
                    children: [
                      {
                        type: 'div',
                        props: {
                          style: { textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' },
                          children: [
                            { type: 'span', props: { style: { color: '#00d4ff', fontSize: '32px', fontWeight: 'bold' }, children: `${prob}%` } },
                            { type: 'span', props: { style: { color: '#ffffff40', fontSize: '11px', letterSpacing: '1px' }, children: 'PROB.' } },
                          ],
                        },
                      },
                      {
                        type: 'div',
                        props: {
                          style: { textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' },
                          children: [
                            { type: 'span', props: { style: { color: '#f59e0b', fontSize: '32px', fontWeight: 'bold' }, children: `${odd}x` } },
                            { type: 'span', props: { style: { color: '#ffffff40', fontSize: '11px', letterSpacing: '1px' }, children: 'CUOTA' } },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
          // Footer
          {
            type: 'div',
            props: {
              style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '24px' },
              children: [
                { type: 'span', props: { style: { color: '#ffffff30', fontSize: '12px' }, children: '⚠️ Juega con responsabilidad' } },
                { type: 'span', props: { style: { color: '#00d4ff', fontSize: '15px', fontWeight: 'bold' }, children: '👉 cfanalisis.com' } },
              ],
            },
          },
        ],
      },
    },
    {
      width: 800,
      height: 450,
      fonts: [{ name: 'Inter', data: fontData, weight: 700, style: 'normal' }],
    }
  );

  const png = await sharp(Buffer.from(svg)).png().toBuffer();

  return new NextResponse(png, {
    headers: {
      'Content-Type': 'image/png',
      // Permite cache en CDN/navegador 1h. La imagen es deterministica por
      // params, asi que misma URL → misma imagen. Si quieres no-cache para
      // pruebas, cambia a 'no-store'.
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}
