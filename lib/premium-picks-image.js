import satori from 'satori';
import sharp from 'sharp';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Render de la tarjeta "Picks Premium": UNA imagen vertical con TODOS los
 * partidos del día y todas sus opciones elegibles, agrupadas por familia de
 * mercado. La usa /api/telegram-premium/futbol-image y baseball-image.
 *
 * Misma identidad visual que /api/pick-image (verde dashboard sobre fondo casi
 * negro) pero en formato tablero compacto: el render es determinista, solo
 * números ya calculados, sin texto generado.
 *
 * Telegram (sendPhoto) exige ancho+alto <= 10000px: si el tablero crece más,
 * la imagen completa se reescala proporcionalmente antes de responder.
 */

const WIDTH = 900;
const PAD_X = 36;
const PAD_TOP = 34;
const PAD_BOTTOM = 28;
const CARD_PAD_X = 22;
const CARD_PAD_TOP = 22;
const CARD_PAD_BOTTOM = 20;
const CARD_GAP = 16;

const TEAMS_FONT = 24;
const TEAMS_LINE_HEIGHT = 30;
const TEAMS_CHARS_PER_LINE = 44; // conservador: sobra antes que recortar

const META_HEIGHT = 22;
const META_MARGIN_TOP = 6;
const PITCHERS_MARGIN_TOP = 8;
const PITCHER_LINE_HEIGHT = 21;

const GROUP_LABEL_MARGIN_TOP = 14;
const GROUP_LABEL_HEIGHT = 26;

const OPTION_MARGIN_TOP = 8;
const OPTION_PAD_Y = 9;
const OPTION_NAME_FONT = 18;
const OPTION_LINE_HEIGHT = 24;
const OPTION_METRICS_WIDTH = 268;
const OPTION_NAME_CHARS_PER_LINE = 40; // ~470px útiles a 18px, conservador

const HEADER_LOGO_HEIGHT = 66;
const HEADER_PILL_MARGIN_TOP = 16;
const HEADER_PILL_HEIGHT = 40;
const HEADER_MARGIN_BOTTOM = 24;

const TELEGRAM_MAX_DIMENSION_SUM = 9900;

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

function textLines(value, charsPerLine) {
  const length = String(value || '').length;
  return Math.max(1, Math.ceil(length / charsPerLine));
}

function optionHeight(option) {
  const lines = textLines(option.name, OPTION_NAME_CHARS_PER_LINE);
  return OPTION_MARGIN_TOP + OPTION_PAD_Y * 2 + Math.max(lines * OPTION_LINE_HEIGHT, OPTION_LINE_HEIGHT);
}

function matchCardHeight(match, groupOrder) {
  const teamsLines = textLines(`${match.homeTeam || 'Local'} vs ${match.awayTeam || 'Visitante'}`, TEAMS_CHARS_PER_LINE);
  let height = CARD_PAD_TOP + teamsLines * TEAMS_LINE_HEIGHT + META_MARGIN_TOP + META_HEIGHT + CARD_PAD_BOTTOM;
  if (match.pitchers?.home || match.pitchers?.away) {
    height += PITCHERS_MARGIN_TOP + PITCHER_LINE_HEIGHT * 2;
  }
  for (const family of groupOrder) {
    const options = match.groups?.[family] || [];
    if (!options.length) continue;
    height += GROUP_LABEL_MARGIN_TOP + GROUP_LABEL_HEIGHT;
    for (const option of options) height += optionHeight(option);
  }
  return height;
}

function cleanStat(value, digits = 2) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : '—';
}

function pitcherLine(role, pitcher) {
  if (!pitcher) return null;
  const stats = pitcher.stats || {};
  return {
    type: 'span',
    props: {
      style: {
        color: C.muted, fontSize: '14px', fontWeight: 400,
        height: `${PITCHER_LINE_HEIGHT}px`, lineHeight: `${PITCHER_LINE_HEIGHT}px`,
      },
      children: `${role}: ${pitcher.name || 'Por confirmar'} · ERA ${cleanStat(stats.era)} · WHIP ${cleanStat(stats.whip)} · K/9 ${cleanStat(stats.k9)}`,
    },
  };
}

export function premiumBoardHeight(matches, groupOrder) {
  const cards = matches.reduce((total, match) => total + matchCardHeight(match, groupOrder), 0);
  const gaps = Math.max(0, matches.length - 1) * CARD_GAP;
  return PAD_TOP + HEADER_LOGO_HEIGHT + HEADER_PILL_MARGIN_TOP + HEADER_PILL_HEIGHT
    + HEADER_MARGIN_BOTTOM + cards + gaps + PAD_BOTTOM;
}

function formatKickoff(kickoff) {
  if (!kickoff) return '';
  const date = new Date(kickoff);
  if (Number.isNaN(date.getTime())) return '';
  const fecha = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota', day: '2-digit', month: '2-digit',
  }).format(date);
  const hora = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
  return `${fecha} · ${hora} COL`;
}

function cleanPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return '—';
  const safe = Math.max(0, Math.min(100, percent));
  return String(Math.floor((safe + 1e-9) * 100) / 100);
}

function metric(label, value, color) {
  return {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: '84px' },
      children: [
        { type: 'span', props: { style: { color: C.faint, fontSize: '10px', fontWeight: 600, letterSpacing: '1.4px' }, children: label } },
        { type: 'span', props: { style: { color, fontSize: '16px', fontWeight: 700 }, children: value } },
      ],
    },
  };
}

function optionRow(option) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex', alignItems: 'center', gap: '12px', width: '100%',
        marginTop: `${OPTION_MARGIN_TOP}px`, padding: `${OPTION_PAD_Y}px 12px`,
        borderRadius: '12px', border: `1px solid ${C.border}`, background: C.surfaceSoft,
      },
      children: [
        {
          type: 'span',
          props: {
            style: { color: C.text, fontSize: `${OPTION_NAME_FONT}px`, fontWeight: 600, lineHeight: `${OPTION_LINE_HEIGHT}px`, flex: 1 },
            children: option.name || 'Opción disponible',
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', gap: '8px', width: `${OPTION_METRICS_WIDTH}px`, justifyContent: 'flex-end', flexShrink: 0 },
            children: [
              metric('PROB', `${cleanPercent(option.probability)}%`, C.green),
              metric('FIAB', `${cleanPercent(option.confidence)}%`, C.cyan),
              metric('CUOTA', option.odd ? Number(option.odd).toFixed(2) : '—', C.amber),
            ],
          },
        },
      ],
    },
  };
}

function groupBlock(label, options) {
  return {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column', width: '100%', marginTop: `${GROUP_LABEL_MARGIN_TOP}px` },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center', gap: '10px', height: `${GROUP_LABEL_HEIGHT}px` },
            children: [
              { type: 'div', props: { style: { width: '6px', height: '6px', borderRadius: '999px', background: C.green } } },
              { type: 'span', props: { style: { color: C.green, fontSize: '13px', fontWeight: 700, letterSpacing: '2.6px' }, children: label } },
            ],
          },
        },
        ...options.map(optionRow),
      ],
    },
  };
}

function matchCard(match, groupOrder, groupLabels) {
  const teams = `${match.homeTeam || 'Local'} vs ${match.awayTeam || 'Visitante'}`;
  const meta = [match.league, formatKickoff(match.kickoff)].filter(Boolean).join('  ·  ');
  return {
    type: 'div',
    props: {
      style: {
        width: '100%', display: 'flex', flexDirection: 'column',
        marginTop: `${CARD_GAP}px`,
        padding: `${CARD_PAD_TOP}px ${CARD_PAD_X}px ${CARD_PAD_BOTTOM}px`,
        borderRadius: '20px', background: C.surface, border: `1px solid ${C.border}`,
      },
      children: [
        {
          type: 'span',
          props: {
            style: { color: C.text, fontSize: `${TEAMS_FONT}px`, fontWeight: 700, lineHeight: `${TEAMS_LINE_HEIGHT}px` },
            children: teams,
          },
        },
        {
          type: 'span',
          props: {
            style: { color: C.muted, fontSize: '15px', fontWeight: 400, height: `${META_HEIGHT}px`, marginTop: `${META_MARGIN_TOP}px` },
            children: meta || ' ',
          },
        },
        ...(match.pitchers?.home || match.pitchers?.away ? [{
          type: 'div',
          props: {
            style: {
              display: 'flex', flexDirection: 'column', width: '100%',
              marginTop: `${PITCHERS_MARGIN_TOP}px`,
            },
            children: [
              pitcherLine('Local', match.pitchers?.home),
              pitcherLine('Visitante', match.pitchers?.away),
            ].filter(Boolean),
          },
        }] : []),
        ...groupOrder
          .filter((family) => (match.groups?.[family] || []).length)
          .map((family) => groupBlock(groupLabels[family] || family.toUpperCase(), match.groups[family])),
      ],
    },
  };
}

function loadFonts() {
  const fonts = [];
  for (const [file, weight] of [['Inter-Regular.ttf', 400], ['Inter-SemiBold.ttf', 600], ['Inter-Bold.ttf', 700]]) {
    const fontPath = join(process.cwd(), 'public/fonts', file);
    if (!existsSync(fontPath)) throw new Error(`Font missing at ${fontPath}`);
    fonts.push({ name: 'Inter', data: readFileSync(fontPath), weight, style: 'normal' });
  }
  return fonts;
}

function loadLogo() {
  for (const path of [join(process.cwd(), 'public/logo-cf.png'), join(process.cwd(), '../public/logo-cf.png')]) {
    if (!existsSync(path)) continue;
    return `data:image/png;base64,${readFileSync(path).toString('base64')}`;
  }
  return null;
}

/**
 * matches: [{ homeTeam, awayTeam, league, kickoff, groups: { familia: [opción] } }]
 * Devuelve un Buffer PNG listo para Telegram.
 */
export async function renderPremiumBoardPng({ title, date, matches, groupOrder, groupLabels }) {
  if (!Array.isArray(matches) || !matches.length) {
    throw new Error('El tablero no trae partidos');
  }

  const height = premiumBoardHeight(matches, groupOrder);
  const fonts = loadFonts();
  const cfLogo = loadLogo();

  const svg = await satori({
    type: 'div',
    props: {
      style: {
        width: `${WIDTH}px`, height: `${height}px`,
        padding: `${PAD_TOP}px ${PAD_X}px ${PAD_BOTTOM}px`,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        background: `linear-gradient(180deg, ${C.bg0} 0%, ${C.bg1} 46%, ${C.bg0} 100%)`,
        color: C.text, fontFamily: 'Inter',
      },
      children: [
        cfLogo
          ? { type: 'img', props: { src: cfLogo, width: 280, height: HEADER_LOGO_HEIGHT, style: { objectFit: 'contain' } } }
          : { type: 'span', props: { style: { color: C.green, fontSize: '38px', fontWeight: 700, letterSpacing: '5px', height: `${HEADER_LOGO_HEIGHT}px` }, children: 'CF ANÁLISIS' } },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex', alignItems: 'center', gap: '14px',
              marginTop: `${HEADER_PILL_MARGIN_TOP}px`, height: `${HEADER_PILL_HEIGHT}px`,
              padding: '0 20px', borderRadius: '999px',
              background: 'rgba(94,230,177,0.08)', border: `1px solid ${C.borderAccent}`,
            },
            children: [
              { type: 'div', props: { style: { width: '7px', height: '7px', borderRadius: '999px', background: C.green } } },
              { type: 'span', props: { style: { color: C.green, fontSize: '16px', fontWeight: 700, letterSpacing: '3px' }, children: title } },
              ...(date ? [
                { type: 'div', props: { style: { width: '1px', height: '15px', background: 'rgba(255,255,255,0.16)' } } },
                { type: 'span', props: { style: { color: C.muted, fontSize: '15px', fontWeight: 400 }, children: date } },
              ] : []),
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: { width: '100%', display: 'flex', flexDirection: 'column', marginTop: `${HEADER_MARGIN_BOTTOM - CARD_GAP}px` },
            children: matches.map((match) => matchCard(match, groupOrder, groupLabels)),
          },
        },
      ].filter(Boolean),
    },
  }, { width: WIDTH, height, fonts });

  let image = sharp(Buffer.from(svg)).png({ quality: 100, compressionLevel: 3 });
  if (WIDTH + height > TELEGRAM_MAX_DIMENSION_SUM) {
    const targetWidth = Math.floor(TELEGRAM_MAX_DIMENSION_SUM / (1 + height / WIDTH));
    image = image.resize({ width: targetWidth });
  }
  return image.toBuffer();
}
