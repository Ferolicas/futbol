/**
 * GET /api/pick-image?match=<JSON>[&fecha=]
 *
 * Genera la tarjeta PNG vertical que n8n publica en Telegram: UN partido con
 * entre UNA y TRES opciones. n8n pide una imagen por cada partido publicable.
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

// ---------------------------------------------------------------------------
// Identidad visual: la misma que el dashboard (verde --dash-green sobre fondo
// casi negro), no la cian/morada antigua.
// ---------------------------------------------------------------------------
const C = {
  bg0: '#03090f',
  bg1: '#061019',
  surface: 'rgba(10,22,29,0.86)',
  surfaceSoft: 'rgba(255,255,255,0.035)',
  border: 'rgba(255,255,255,0.085)',
  borderAccent: 'rgba(94,230,177,0.26)',
  green: '#5ee6b1',
  cyan: '#22d3ee',
  amber: '#f8c95d',
  text: '#edf6f4',
  muted: '#8fa1aa',
  faint: '#64798a',
};

// Los nombres reales son largos ("Total partido — Córners — Menos de 13.5"), así
// que la métrica va DEBAJO del nombre y no a su lado: el nombre dispone de todo
// el ancho y casi siempre cabe en una línea.
const NAME_FONT = 23;
const NAME_LINE_HEIGHT = 31;
const NAME_CHARS_PER_LINE = 44;   // ~616px útiles / ~14px por carácter a 23px
// Alto real de una fila con el nombre en una línea, medido sobre el render.
// Se redondea al alza porque satori recorta lo que sobresale del lienzo.
const ROW_BASE_HEIGHT = 140;
const ROW_GAP = 14;

function nameLines(option) {
  const length = String(option.name || '').length;
  return Math.max(1, Math.ceil(length / NAME_CHARS_PER_LINE));
}

function optionRowHeight(option) {
  return ROW_BASE_HEIGHT + (nameLines(option) - 1) * NAME_LINE_HEIGHT;
}

function optionMetric(label, value, color, strong) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex', alignItems: 'baseline', gap: '8px',
        padding: '7px 13px', borderRadius: '10px',
        background: strong ? 'rgba(94,230,177,0.10)' : C.surfaceSoft,
        border: `1px solid ${strong ? C.borderAccent : C.border}`,
      },
      children: [
        { type: 'span', props: { style: { color: C.faint, fontSize: '12px', fontWeight: 600, letterSpacing: '1.6px' }, children: label } },
        { type: 'span', props: { style: { color, fontSize: '23px', fontWeight: 700 }, children: value } },
      ],
    },
  };
}

function optionRow(option, index) {
  return {
    type: 'div',
    props: {
      style: {
        width: '100%', display: 'flex', flexDirection: 'column', gap: '12px',
        padding: '18px 22px', borderRadius: '18px',
        border: `1px solid ${C.border}`,
        background: C.surfaceSoft,
      },
      children: [
        {
          type: 'div', props: {
            style: { display: 'flex', alignItems: 'flex-start', gap: '16px', width: '100%' },
            children: [
              {
                type: 'div', props: {
                  style: {
                    width: '42px', height: '42px', borderRadius: '12px', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(94,230,177,0.11)', border: `1px solid ${C.borderAccent}`,
                  },
                  children: [{ type: 'span', props: { style: { color: C.green, fontSize: '19px', fontWeight: 700 }, children: String(index + 1) } }],
                },
              },
              {
                type: 'span', props: {
                  style: { color: C.text, fontSize: `${NAME_FONT}px`, fontWeight: 600, lineHeight: 1.3, flex: 1, paddingTop: '6px' },
                  children: option.name || 'Opción disponible',
                },
              },
            ],
          },
        },
        {
          type: 'div', props: {
            style: { display: 'flex', alignItems: 'center', gap: '10px', marginLeft: '58px' },
            children: [
              optionMetric('PROB', `${option.probability}%`, C.green, true),
              optionMetric('FIAB', `${option.confidence}%`, C.cyan, false),
              optionMetric('CUOTA', `${option.odd}`, C.amber, false),
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
    // Cabecera + bloque del partido + pie, más cada fila con el alto que pida su
    // nombre. Sin esto, un nombre de dos o tres líneas se salía por debajo y se
    // solapaba con el pie.
    const rowsHeight = match.options.reduce((total, option) => total + optionRowHeight(option), 0)
      + Math.max(0, match.options.length - 1) * ROW_GAP;
    const height = 492 + rowsHeight;

    // Tres pesos: sin ellos todo sale en negrita y el conjunto se ve plano.
    const fonts = [];
    for (const [file, weight] of [['Inter-Regular.ttf', 400], ['Inter-SemiBold.ttf', 600], ['Inter-Bold.ttf', 700]]) {
      const fontPath = join(process.cwd(), 'public/fonts', file);
      if (!existsSync(fontPath)) {
        return Response.json({ error: `Font missing at ${fontPath}` }, { status: 500 });
      }
      fonts.push({ name: 'Inter', data: readFileSync(fontPath), weight, style: 'normal' });
    }

    // Logo metalizado (el de la app), no el escudo antiguo.
    let cfLogo = null;
    for (const path of [join(process.cwd(), 'public/logo-cf.png'), join(process.cwd(), '../public/logo-cf.png')]) {
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
          width: `${WIDTH}px`, height: `${height}px`, padding: '38px 38px 30px',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          background: `linear-gradient(180deg, ${C.bg0} 0%, ${C.bg1} 46%, ${C.bg0} 100%)`,
          color: C.text, fontFamily: 'Inter',
        },
        children: [
          // ---- Cabecera: logo + antetítulo + fecha -------------------------
          cfLogo
            ? { type: 'img', props: { src: cfLogo, width: 300, height: 72, style: { objectFit: 'contain' } } }
            : { type: 'span', props: { style: { color: C.green, fontSize: '40px', fontWeight: 700, letterSpacing: '5px' }, children: 'CF ANÁLISIS' } },
          {
            type: 'div', props: {
              style: {
                display: 'flex', alignItems: 'center', gap: '14px', marginTop: '22px',
                padding: '9px 20px', borderRadius: '999px',
                background: 'rgba(94,230,177,0.08)', border: `1px solid ${C.borderAccent}`,
              },
              children: [
                { type: 'div', props: { style: { width: '7px', height: '7px', borderRadius: '999px', background: C.green } } },
                { type: 'span', props: { style: { color: C.green, fontSize: '17px', fontWeight: 700, letterSpacing: '3.4px' }, children: 'APUESTA DEL DÍA' } },
                ...(date ? [
                  { type: 'div', props: { style: { width: '1px', height: '15px', background: 'rgba(255,255,255,0.16)' } } },
                  { type: 'span', props: { style: { color: C.muted, fontSize: '16px', fontWeight: 400 }, children: date } },
                ] : []),
              ],
            },
          },

          // ---- Partido ----------------------------------------------------
          {
            type: 'div', props: {
              style: {
                width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center',
                margin: '24px 0 22px', padding: '24px 26px 20px', borderRadius: '22px', gap: '14px',
                background: C.surface, border: `1px solid ${C.border}`,
              },
              children: [
                {
                  type: 'div', props: {
                    style: { display: 'flex', alignItems: 'center', width: '100%', gap: '18px' },
                    children: [
                      logoBadge(homeLogo, match.homeTeam, C.green),
                      {
                        type: 'div', props: {
                          style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: '7px' },
                          children: [
                            { type: 'span', props: { style: { color: C.text, fontSize: '25px', fontWeight: 700, textAlign: 'center', lineHeight: 1.2 }, children: match.homeTeam || 'Local' } },
                            { type: 'span', props: { style: { color: C.faint, fontSize: '13px', fontWeight: 600, letterSpacing: '3px' }, children: 'VS' } },
                            { type: 'span', props: { style: { color: C.text, fontSize: '25px', fontWeight: 700, textAlign: 'center', lineHeight: 1.2 }, children: match.awayTeam || 'Visitante' } },
                          ],
                        },
                      },
                      logoBadge(awayLogo, match.awayTeam, C.cyan),
                    ],
                  },
                },
                {
                  type: 'span', props: {
                    style: { color: C.muted, fontSize: '16px', fontWeight: 400 },
                    children: [match.league, match.time].filter(Boolean).join('  ·  ') || ' ',
                  },
                },
              ],
            },
          },

          // ---- Opciones ---------------------------------------------------
          {
            type: 'div', props: {
              style: { width: '100%', display: 'flex', flexDirection: 'column', gap: `${ROW_GAP}px` },
              children: match.options.map((option, index) => optionRow(option, index)),
            },
          },

          // ---- Pie --------------------------------------------------------
          {
            type: 'div', props: {
              style: {
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px',
                paddingTop: '22px', marginTop: 'auto', borderTop: `1px solid ${C.border}`,
              },
              children: [
                { type: 'span', props: { style: { color: C.green, fontSize: '18px', fontWeight: 700, letterSpacing: '2.4px' }, children: 'CFANALISIS.COM' } },
                { type: 'div', props: { style: { width: '4px', height: '4px', borderRadius: '999px', background: C.faint } } },
                { type: 'span', props: { style: { color: C.faint, fontSize: '15px', fontWeight: 400 }, children: 'Análisis estadístico, no consejo financiero' } },
              ],
            },
          },
        ].filter(Boolean),
      },
    }, {
      width: WIDTH,
      height,
      fonts,
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
