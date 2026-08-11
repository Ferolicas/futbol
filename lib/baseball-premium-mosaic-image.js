import satori from 'satori';
import sharp from 'sharp';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  BASEBALL_MOSAIC_LOGICAL_WIDTH,
  BASEBALL_MOSAIC_LOGICAL_HEIGHT,
  BASEBALL_MOSAIC_WIDTH,
  BASEBALL_MOSAIC_HEIGHT,
  baseballMosaicGrid,
} from './baseball-premium-mosaic-layout.js';

const SVG_DENSITY = 72 * (BASEBALL_MOSAIC_WIDTH / BASEBALL_MOSAIC_LOGICAL_WIDTH);

const C = {
  bg0: '#02070c',
  bg1: '#07151d',
  surface: 'rgba(8,21,29,0.94)',
  surfaceSoft: 'rgba(255,255,255,0.035)',
  border: 'rgba(255,255,255,0.10)',
  green: '#5ee6b1',
  cyan: '#38d9f5',
  amber: '#ffd166',
  text: '#f2f8f7',
  muted: '#9aadb6',
  faint: '#647987',
};

function cleanPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return String(Math.floor(Math.max(0, Math.min(100, numeric)) * 100) / 100);
}

function cleanStat(value, digits = 2) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : '—';
}

function formatKickoff(kickoff) {
  if (!kickoff) return '';
  const value = new Date(kickoff);
  if (Number.isNaN(value.getTime())) return '';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value).replace(',', ' ·') + ' COL';
}

function pitcherSummary(label, pitcher) {
  const stats = pitcher?.stats || {};
  return `${label}: ${pitcher?.name || 'Por confirmar'} · ERA ${cleanStat(stats.era)} · WHIP ${cleanStat(stats.whip)} · K/9 ${cleanStat(stats.k9)}`;
}

function loadFonts() {
  return [['Inter-Regular.ttf', 400], ['Inter-SemiBold.ttf', 600], ['Inter-Bold.ttf', 700]].map(([file, weight]) => {
    const fontPath = join(process.cwd(), 'public/fonts', file);
    if (!existsSync(fontPath)) throw new Error(`Font missing at ${fontPath}`);
    return { name: 'Inter', data: readFileSync(fontPath), weight, style: 'normal' };
  });
}

function loadLogo() {
  for (const path of [join(process.cwd(), 'public/logo-cf.png'), join(process.cwd(), '../public/logo-cf.png')]) {
    if (existsSync(path)) return `data:image/png;base64,${readFileSync(path).toString('base64')}`;
  }
  return null;
}

function metricPill(label, value, color, compact) {
  return {
    type: 'span',
    props: {
      style: {
        minWidth: '62px', padding: compact ? '0 4px' : '1px 5px', borderRadius: '7px',
        color, background: 'rgba(255,255,255,0.045)',
        fontSize: compact ? '10px' : '11px', fontWeight: 700, textAlign: 'center',
      },
      children: `${label} ${value}`,
    },
  };
}

function optionRow(option, index, compact) {
  return {
    type: 'div',
    props: {
      style: {
        width: '100%', height: compact ? '34px' : '42px', display: 'flex', flexDirection: 'column',
        justifyContent: 'center', padding: compact ? '2px 7px' : '3px 8px', borderRadius: '8px',
        border: `1px solid ${index % 2 ? 'rgba(255,255,255,0.055)' : C.border}`,
        background: index % 2 ? 'rgba(255,255,255,0.018)' : C.surfaceSoft,
      },
      children: [
        {
          type: 'span',
          props: {
            style: {
              color: C.text, fontSize: compact ? '11px' : '13px', fontWeight: 600,
              lineHeight: compact ? '13px' : '16px', width: '100%', maxHeight: compact ? '13px' : '16px',
              overflow: 'hidden',
            },
            children: option.name || 'Opción disponible',
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', width: '100%', gap: '5px', marginTop: compact ? '1px' : '2px' },
            children: [
              metricPill('P', `${cleanPercent(option.probability)}%`, C.green, compact),
              metricPill('F', `${cleanPercent(option.confidence)}%`, C.cyan, compact),
              metricPill('@', option.odd ? Number(option.odd).toFixed(2) : '—', C.amber, compact),
            ],
          },
        },
      ],
    },
  };
}

function marketCard(card, compact) {
  const continuation = card.parts > 1 ? ` · ${card.part}/${card.parts}` : '';
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, height: '100%',
        padding: compact ? '10px' : '14px', borderRadius: '18px', background: C.surface,
        border: `1px solid ${C.border}`,
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center', gap: '8px', height: compact ? '22px' : '28px', marginBottom: compact ? '5px' : '8px' },
            children: [
              { type: 'div', props: { style: { width: '7px', height: '7px', borderRadius: '999px', background: C.green } } },
              { type: 'span', props: { style: { color: C.green, fontSize: compact ? '12px' : '15px', fontWeight: 700, letterSpacing: compact ? '1px' : '1.5px' }, children: `${card.label}${continuation}` } },
              { type: 'span', props: { style: { color: C.faint, fontSize: compact ? '10px' : '12px', fontWeight: 600, marginLeft: 'auto' }, children: `${card.options.length} OPCIONES` } },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: { width: '100%', display: 'flex', flexDirection: 'column', gap: compact ? '2px' : '4px' },
            children: card.options.map((option, index) => optionRow(option, index, compact)),
          },
        },
      ],
    },
  };
}

function mosaicGrid(cards) {
  const shape = baseballMosaicGrid(cards.length);
  const rows = [];
  for (let index = 0; index < cards.length; index += shape.columns) {
    rows.push(cards.slice(index, index + shape.columns));
  }
  const compact = shape.rows >= 4;
  return {
    type: 'div',
    props: {
      style: { width: '100%', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px', minHeight: 0 },
      children: rows.map((row) => ({
        type: 'div',
        props: {
          style: { display: 'flex', flex: 1, width: '100%', gap: '16px', justifyContent: 'center', minHeight: 0 },
          children: row.map((card) => marketCard(card, compact)),
        },
      })),
    },
  };
}

export async function renderBaseballPremiumMosaicPng({ match, date, page }) {
  if (!match || !page?.cards?.length) throw new Error('El mosaico no trae tarjetas');
  const fonts = loadFonts();
  const cfLogo = loadLogo();
  const teams = `${match.homeTeam || 'Local'} vs ${match.awayTeam || 'Visitante'}`;
  const meta = [match.league, formatKickoff(match.kickoff)].filter(Boolean).join('  ·  ');
  const pageLabel = page.pages > 1 ? `PÁGINA ${page.page}/${page.pages}` : 'RESUMEN DEL PARTIDO';

  const svg = await satori({
    type: 'div',
    props: {
      style: {
        width: `${BASEBALL_MOSAIC_LOGICAL_WIDTH}px`, height: `${BASEBALL_MOSAIC_LOGICAL_HEIGHT}px`,
        padding: '38px 56px 44px', display: 'flex', flexDirection: 'column',
        background: `linear-gradient(135deg, ${C.bg0} 0%, ${C.bg1} 54%, ${C.bg0} 100%)`,
        color: C.text, fontFamily: 'Inter',
      },
      children: [
        {
          type: 'div',
          props: {
            style: { width: '100%', height: '164px', display: 'flex', alignItems: 'center', marginBottom: '22px' },
            children: [
              cfLogo
                ? { type: 'img', props: { src: cfLogo, width: 300, height: 72, style: { objectFit: 'contain', marginRight: '36px' } } }
                : { type: 'span', props: { style: { color: C.green, fontSize: '38px', fontWeight: 700, marginRight: '36px' }, children: 'CF ANÁLISIS' } },
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 },
                  children: [
                    { type: 'span', props: { style: { color: C.text, fontSize: '40px', lineHeight: '48px', fontWeight: 700 }, children: teams } },
                    { type: 'span', props: { style: { color: C.muted, fontSize: '19px', lineHeight: '28px', fontWeight: 400 }, children: meta || ' ' } },
                    {
                      type: 'div',
                      props: {
                        style: { display: 'flex', gap: '28px', marginTop: '7px' },
                        children: [
                          { type: 'span', props: { style: { color: C.muted, fontSize: '17px', fontWeight: 500 }, children: pitcherSummary('Local', match.pitchers?.home) } },
                          { type: 'span', props: { style: { color: C.muted, fontSize: '17px', fontWeight: 500 }, children: pitcherSummary('Visitante', match.pitchers?.away) } },
                        ],
                      },
                    },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'center',
                    minWidth: '320px', height: '92px', padding: '0 24px', borderRadius: '16px',
                    background: 'rgba(94,230,177,0.07)', border: `1px solid rgba(94,230,177,0.24)`,
                  },
                  children: [
                    { type: 'span', props: { style: { color: C.green, fontSize: '19px', fontWeight: 700, letterSpacing: '2.4px' }, children: 'PICKS PREMIUM · BÉISBOL' } },
                    { type: 'span', props: { style: { color: C.muted, fontSize: '17px', fontWeight: 500, marginTop: '7px' }, children: `${date || ''} · ${pageLabel}` } },
                  ],
                },
              },
            ],
          },
        },
        mosaicGrid(page.cards),
      ],
    },
  }, {
    width: BASEBALL_MOSAIC_LOGICAL_WIDTH,
    height: BASEBALL_MOSAIC_LOGICAL_HEIGHT,
    fonts,
  });

  return sharp(Buffer.from(svg), { density: SVG_DENSITY })
    .png({ quality: 100, compressionLevel: 3 })
    .toBuffer();
}
