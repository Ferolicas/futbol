/**
 * GET /api/pick-image?match=<JSON>[&fecha=]
 *
 * Genera la tarjeta PNG vertical que n8n publica en Telegram: UN partido con
 * sus TRES opciones. Para publicar tres partidos, n8n pide tres imágenes.
 *
 * `match` es un elemento de `data.matches` de /api/combinada-dia:
 *   { homeTeam, awayTeam, homeLogo, awayLogo, league, leagueLogo, kickoff,
 *     options: [{ name, probability, confidence, odd }, ...] }
 *
 * También admite los parámetros sueltos `home`, `away`, `league`, `hora`,
 * `homeLogo`, `awayLogo` y `options=<JSON>` para probar a mano.
 *
 * El render es deliberadamente determinista: solo muestra las opciones y sus
 * números, sin recomendaciones ni análisis generado por IA.
 */

import satori from 'satori';
import sharp from 'sharp';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WIDTH = 800;
const MAX_OPTIONS = 3;
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

function cleanPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return '—';
  const safe = Math.max(0, Math.min(100, percent));
  return String(Math.floor((safe + 1e-9) * 100) / 100);
}

// La probabilidad se publica topada al 95%; es política de producto y no debe
// aplicarse a la fiabilidad, que sí se muestra tal cual (96,4% no es 95%).
function cleanProbability(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return '—';
  if (percent >= 95) return '95';
  return cleanPercent(percent);
}

function initials(name) {
  const words = cleanText(name, 80).split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words.at(-1)[0]}`.toUpperCase();
}

function kickoffTime(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return cleanText(value, 24);
  return parsed.toISOString().slice(11, 16);
}

function sanitizeOption(option = {}) {
  return {
    name: cleanText(option.name || option.pick, 150),
    probability: cleanProbability(option.probability),
    confidence: cleanPercent(option.confidence ?? option.reliability),
    odd: cleanOdd(option.odd),
  };
}

function sanitizeMatch(match = {}, options = []) {
  return {
    homeTeam: cleanText(match.homeTeam || match.home, 60),
    awayTeam: cleanText(match.awayTeam || match.away, 60),
    homeLogo: cleanText(match.homeLogo, 500),
    awayLogo: cleanText(match.awayLogo, 500),
    league: cleanText(match.league, 70),
    time: cleanText(match.time || match.hora, 24) || kickoffTime(match.kickoff),
    options: options.slice(0, MAX_OPTIONS).map(sanitizeOption),
  };
}

function parseJsonParam(raw, label) {
  if (!raw) return null;
  if (raw.length > MAX_PAYLOAD_LENGTH) throw new Error(`Payload de ${label} demasiado grande`);
  return JSON.parse(raw);
}

function readMatch(searchParams) {
  const parsed = parseJsonParam(searchParams.get('match'), 'partido');
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const options = Array.isArray(parsed.options) ? parsed.options : [];
    if (!options.length) throw new Error('El partido no trae opciones');
    return sanitizeMatch(parsed, options);
  }

  const looseOptions = parseJsonParam(searchParams.get('options'), 'opciones');
  if (!Array.isArray(looseOptions) || !looseOptions.length) {
    throw new Error('Falta el partido: usa match=<JSON> u options=<JSON>');
  }

  const label = cleanText(searchParams.get('match') || '', 120);
  const [fallbackHome = '', fallbackAway = ''] = label.split(/\s+vs\s+/i);
  return sanitizeMatch({
    homeTeam: searchParams.get('home') || fallbackHome,
    awayTeam: searchParams.get('away') || fallbackAway,
    homeLogo: searchParams.get('homeLogo'),
    awayLogo: searchParams.get('awayLogo'),
    league: searchParams.get('league'),
    hora: searchParams.get('hora'),
  }, looseOptions);
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
        width: '86px', height: '86px', borderRadius: '22px', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `${accent}18`, border: `1px solid ${accent}70`,
      },
      children: logo
        ? [{ type: 'img', props: { src: logo, width: 66, height: 66, style: { objectFit: 'contain' } } }]
        : [{ type: 'span', props: { style: { color: accent, fontSize: '26px', fontWeight: 700 }, children: initials(team) } }],
    },
  };
}

function optionMetric(label, value, color) {
  return {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', width: '108px' },
      children: [
        { type: 'span', props: { style: { color: '#93a4bd', fontSize: '13px', letterSpacing: '2px' }, children: label } },
        { type: 'span', props: { style: { color, fontSize: '30px', fontWeight: 700 }, children: value } },
      ],
    },
  };
}

function optionRow(option, index) {
  return {
    type: 'div',
    props: {
      style: {
        width: '100%', display: 'flex', alignItems: 'center', gap: '18px',
        padding: '20px 24px', borderRadius: '20px',
        border: '1px solid rgba(0,212,255,0.24)',
        background: 'linear-gradient(135deg, rgba(0,212,255,0.08), rgba(124,58,237,0.08))',
      },
      children: [
        {
          type: 'div', props: {
            style: {
              width: '44px', height: '44px', borderRadius: '14px', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0,212,255,0.14)', border: '1px solid rgba(0,212,255,0.42)',
            },
            children: [{ type: 'span', props: { style: { color: '#00d4ff', fontSize: '20px', fontWeight: 700 }, children: String(index + 1) } }],
          },
        },
        {
          type: 'span', props: {
            style: { color: '#ffffff', fontSize: '24px', fontWeight: 700, lineHeight: 1.25, flex: 1 },
            children: option.name || 'Opción disponible',
          },
        },
        {
          type: 'div', props: {
            style: { display: 'flex', alignItems: 'center', flexShrink: 0 },
            children: [
              optionMetric('PROB', `${option.probability}%`, '#00d4ff'),
              optionMetric('FIAB', `${option.confidence}%`, '#4ade80'),
              optionMetric('CUOTA', `${option.odd}x`, '#f59e0b'),
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
    const match = readMatch(searchParams);
    const date = cleanText(searchParams.get('fecha'), 40);
    // Cabecera + bloque del partido + una fila por opción + pie.
    const height = 570 + match.options.length * 118;

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

    const [homeLogo, awayLogo] = await Promise.all([
      toBase64(match.homeLogo),
      toBase64(match.awayLogo),
    ]);

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
                width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center',
                margin: '26px 0', padding: '24px 28px', borderRadius: '20px', gap: '16px',
                background: 'rgba(15,23,42,0.92)', border: '1px solid rgba(255,255,255,0.10)',
              },
              children: [
                {
                  type: 'div', props: {
                    style: { display: 'flex', alignItems: 'center', width: '100%', gap: '20px' },
                    children: [
                      logoBadge(homeLogo, match.homeTeam, '#00d4ff'),
                      {
                        type: 'div', props: {
                          style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: '6px' },
                          children: [
                            { type: 'span', props: { style: { color: '#ffffff', fontSize: '24px', fontWeight: 700, textAlign: 'center' }, children: match.homeTeam || 'Local' } },
                            { type: 'span', props: { style: { color: '#64748b', fontSize: '14px', letterSpacing: '3px' }, children: 'VS' } },
                            { type: 'span', props: { style: { color: '#ffffff', fontSize: '24px', fontWeight: 700, textAlign: 'center' }, children: match.awayTeam || 'Visitante' } },
                          ],
                        },
                      },
                      logoBadge(awayLogo, match.awayTeam, '#a78bfa'),
                    ],
                  },
                },
                {
                  type: 'span', props: {
                    style: { color: '#93a4bd', fontSize: '17px' },
                    children: [match.league, match.time].filter(Boolean).join(' · ') || ' ',
                  },
                },
              ],
            },
          },
          {
            type: 'div', props: {
              style: { width: '100%', display: 'flex', flexDirection: 'column', gap: '14px', flex: 1 },
              children: match.options.map((option, index) => optionRow(option, index)),
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
