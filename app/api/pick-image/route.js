/**
 * GET /api/pick-image
 *
 * Genera la tarjeta PNG vertical que n8n publica en Telegram. Acepta una
 * selección legacy o `selections=<JSON>` con hasta tres partidos. El render es
 * deliberadamente determinista: no contiene análisis generado por IA.
 */

import satori from 'satori';
import sharp from 'sharp';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WIDTH = 800;
const MAX_SELECTIONS = 3;
const MAX_PAYLOAD_LENGTH = 12_000;
const ALLOWED_IMG_HOSTS = new Set([
  'media.api-sports.io',
  'www.mlbstatic.com',
  'mlbstatic.com',
]);

function cleanText(value, maxLength = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanOdd(value) {
  const odd = Number(value);
  return Number.isFinite(odd) && odd > 0 ? odd.toFixed(2) : '—';
}

function cleanProbability(value) {
  const probability = Number(value);
  if (!Number.isFinite(probability)) return '—';
  const safe = Math.max(0, probability);
  return String(safe >= 95 ? 95 : Math.floor((safe + 1e-9) * 10) / 10);
}

function initials(name) {
  const words = cleanText(name, 80).split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words.at(-1)[0]}`.toUpperCase();
}

function sanitizeSelection(selection = {}) {
  return {
    homeTeam: cleanText(selection.homeTeam || selection.home, 60),
    awayTeam: cleanText(selection.awayTeam || selection.away, 60),
    homeLogo: cleanText(selection.homeLogo, 500),
    awayLogo: cleanText(selection.awayLogo, 500),
    leagueLogo: cleanText(selection.leagueLogo, 500),
    league: cleanText(selection.league, 70),
    name: cleanText(selection.name || selection.pick, 150),
    probability: cleanProbability(selection.probability),
    odd: cleanOdd(selection.odd),
    time: cleanText(selection.time || selection.hora, 24),
  };
}

function readSelections(searchParams) {
  const raw = searchParams.get('selections');
  if (raw) {
    if (raw.length > MAX_PAYLOAD_LENGTH) throw new Error('Payload de selecciones demasiado grande');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Selecciones inválidas');
    const selections = parsed.slice(0, MAX_SELECTIONS).map(sanitizeSelection);
    if (selections.length) return selections;
  }

  const match = cleanText(searchParams.get('match') || 'Partido del día', 120);
  const [fallbackHome = '', fallbackAway = ''] = match.split(/\s+vs\s+/i);
  return [sanitizeSelection({
    homeTeam: searchParams.get('home') || fallbackHome,
    awayTeam: searchParams.get('away') || fallbackAway,
    homeLogo: searchParams.get('homeLogo'),
    awayLogo: searchParams.get('awayLogo'),
    leagueLogo: searchParams.get('leagueLogo'),
    league: searchParams.get('league'),
    name: searchParams.get('pick'),
    probability: searchParams.get('prob'),
    odd: searchParams.get('odd'),
    time: searchParams.get('hora'),
  })];
}

async function toBase64(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!ALLOWED_IMG_HOSTS.has(parsed.hostname)) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(parsed, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return null;
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > 2_000_000) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 2_000_000) return null;
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

function logoBadge(logo, team, accent) {
  return {
    type: 'div',
    props: {
      style: {
        width: '72px', height: '72px', borderRadius: '18px', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `${accent}18`, border: `1px solid ${accent}70`,
      },
      children: logo
        ? [{ type: 'img', props: { src: logo, width: 56, height: 56, style: { objectFit: 'contain' } } }]
        : [{ type: 'span', props: { style: { color: accent, fontSize: '22px', fontWeight: 700 }, children: initials(team) } }],
    },
  };
}

function metric(label, value, color) {
  return {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', flex: 1 },
      children: [
        { type: 'span', props: { style: { color: '#93a4bd', fontSize: '15px', letterSpacing: '3px' }, children: label } },
        { type: 'span', props: { style: { color, fontSize: '54px', fontWeight: 700 }, children: value } },
      ],
    },
  };
}

function selectionCard(selection, logos, index, total) {
  const compact = total === 3;
  return {
    type: 'div',
    props: {
      style: {
        width: '100%', display: 'flex', flexDirection: 'column',
        padding: compact ? '20px 22px' : '24px 26px',
        borderRadius: '20px', border: '1px solid rgba(0,212,255,0.24)',
        background: 'linear-gradient(135deg, rgba(0,212,255,0.08), rgba(124,58,237,0.08))',
        gap: compact ? '14px' : '18px',
      },
      children: [
        {
          type: 'div', props: {
            style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' },
            children: [
              { type: 'span', props: { style: { color: '#00d4ff', fontSize: '15px', fontWeight: 700, letterSpacing: '2px' }, children: total === 1 ? 'SELECCIÓN' : `SELECCIÓN ${index + 1}` } },
              { type: 'span', props: { style: { color: '#93a4bd', fontSize: '15px' }, children: [selection.league, selection.time].filter(Boolean).join(' · ') } },
            ],
          },
        },
        {
          type: 'div', props: {
            style: { display: 'flex', alignItems: 'center', width: '100%', gap: '18px' },
            children: [
              logoBadge(logos.home, selection.homeTeam, '#00d4ff'),
              {
                type: 'div', props: {
                  style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: '5px' },
                  children: [
                    { type: 'span', props: { style: { color: '#ffffff', fontSize: compact ? '18px' : '21px', fontWeight: 700, textAlign: 'center' }, children: selection.homeTeam || 'Local' } },
                    { type: 'span', props: { style: { color: '#64748b', fontSize: '13px', letterSpacing: '2px' }, children: 'VS' } },
                    { type: 'span', props: { style: { color: '#ffffff', fontSize: compact ? '18px' : '21px', fontWeight: 700, textAlign: 'center' }, children: selection.awayTeam || 'Visitante' } },
                  ],
                },
              },
              logoBadge(logos.away, selection.awayTeam, '#a78bfa'),
            ],
          },
        },
        {
          type: 'div', props: {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '16px' },
            children: [
              { type: 'span', props: { style: { color: '#ffffff', fontSize: compact ? '22px' : '27px', fontWeight: 700, lineHeight: 1.25, flex: 1 }, children: selection.name || 'Pronóstico disponible' } },
              {
                type: 'div', props: {
                  style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0, gap: '4px' },
                  children: [
                    { type: 'span', props: { style: { color: '#00d4ff', fontSize: '20px', fontWeight: 700 }, children: `${selection.probability}%` } },
                    { type: 'span', props: { style: { color: '#f59e0b', fontSize: '20px', fontWeight: 700 }, children: `${selection.odd}x` } },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const selections = readSelections(searchParams);
    const combinedOdd = cleanOdd(searchParams.get('odd'));
    const combinedProbability = cleanProbability(searchParams.get('prob'));
    const date = cleanText(searchParams.get('fecha'), 40);
    const height = selections.length === 1 ? 1000 : selections.length === 2 ? 1220 : 1422;

    const fontPath = join(process.cwd(), 'public/fonts/Inter-Bold.ttf');
    if (!existsSync(fontPath)) {
      return Response.json({ error: `Font missing at ${fontPath}` }, { status: 500 });
    }
    const fontData = readFileSync(fontPath);

    let cfLogo = null;
    for (const path of [join(process.cwd(), 'public/vflogo.png'), join(process.cwd(), '../public/vflogo.png')]) {
      if (!existsSync(path)) continue;
      cfLogo = `data:image/png;base64,${readFileSync(path).toString('base64')}`;
      break;
    }

    const selectionLogos = await Promise.all(selections.map(async selection => ({
      home: await toBase64(selection.homeLogo),
      away: await toBase64(selection.awayLogo),
    })));

    const svg = await satori({
      type: 'div',
      props: {
        style: {
          width: `${WIDTH}px`, height: `${height}px`, padding: '42px 40px 34px',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          background: 'linear-gradient(180deg, #030712 0%, #081126 52%, #030712 100%)',
          color: '#ffffff', fontFamily: 'Inter',
        },
        children: [
          cfLogo
            ? { type: 'img', props: { src: cfLogo, width: 260, height: 126, style: { objectFit: 'contain' } } }
            : { type: 'span', props: { style: { color: '#00d4ff', fontSize: '42px', fontWeight: 700, letterSpacing: '5px' }, children: 'CF ANÁLISIS' } },
          { type: 'div', props: { style: { width: '100%', height: '1px', margin: '18px 0 26px', background: 'linear-gradient(90deg, transparent, #00d4ff70, transparent)' } } },
          { type: 'span', props: { style: { color: '#ffffff', fontSize: '34px', fontWeight: 700, letterSpacing: '3px' }, children: 'APUESTA DEL DÍA' } },
          date ? { type: 'span', props: { style: { color: '#93a4bd', fontSize: '18px', marginTop: '8px' }, children: date } } : null,
          {
            type: 'div', props: {
              style: {
                width: '100%', display: 'flex', alignItems: 'center',
                margin: '28px 0', padding: '22px 30px', borderRadius: '20px',
                background: 'rgba(15,23,42,0.92)', border: '1px solid rgba(255,255,255,0.10)',
              },
              children: [
                metric('CUOTA TOTAL', `${combinedOdd}x`, '#f59e0b'),
                { type: 'div', props: { style: { width: '1px', height: '68px', background: 'rgba(255,255,255,0.12)' } } },
                metric('PROBABILIDAD', `${combinedProbability}%`, '#00d4ff'),
              ],
            },
          },
          {
            type: 'div', props: {
              style: { width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: selections.length === 3 ? '14px' : '20px', flex: 1 },
              children: selections.map((selection, index) => selectionCard(selection, selectionLogos[index], index, selections.length)),
            },
          },
          {
            type: 'div', props: {
              style: { width: '100%', display: 'flex', justifyContent: 'center', paddingTop: '24px', marginTop: 'auto', borderTop: '1px solid rgba(255,255,255,0.08)' },
              children: [{ type: 'span', props: { style: { color: '#00d4ff', fontSize: '19px', fontWeight: 700, letterSpacing: '2px' }, children: 'CFANALISIS.COM' } }],
            },
          },
        ].filter(Boolean),
      },
    }, {
      width: WIDTH,
      height,
      fonts: [{ name: 'Inter', data: fontData, weight: 700, style: 'normal' }],
    });

    const png = await sharp(Buffer.from(svg)).png({ quality: 100, compressionLevel: 3 }).toBuffer();
    return new Response(png, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('[pick-image]', error);
    return Response.json({ error: 'No se pudo generar la imagen' }, { status: 400 });
  }
}
