// Compartir una tarjeta de partido como imagen, igual que el "compartir
// apuesta" de una casa: se dibuja un PNG con el partido y sus opciones y se
// entrega a la hoja de compartir del dispositivo (WhatsApp, Telegram, etc.).
//
// Todo ocurre en el navegador con los datos que la tarjeta YA tiene en
// pantalla. No hay ruta de servidor: así un plan Free solo puede compartir la
// opción que el servidor le dejó ver, y generar la imagen no cuesta nada.

const WIDTH = 1080;
const PAD = 56;
const FONT = '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const COLOR = {
  bg0: '#03090f', bg1: '#071520', surface: 'rgba(255,255,255,0.045)', border: 'rgba(255,255,255,0.10)',
  green: '#5ee6b1', cyan: '#22d3ee', amber: '#f8c95d', text: '#edf6f4', muted: '#8fa1aa', faint: '#64798a',
};
const MAX_PICKS = 4;

const FINAL = new Set(['FT', 'AET', 'PEN', 'AOT', 'FINAL']);
const LIVE = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'Q1', 'Q2', 'Q3', 'Q4', 'OT']);

function percentOf(pick) {
  const value = Number(pick?.rawProbability ?? pick?.probability);
  if (!Number.isFinite(value)) return null;
  // Misma política pública que el resto de la app: tope visual del 95%.
  return Math.min(95, Math.floor(value * 100) / 100);
}

/**
 * Opciones que viajan en la imagen. Si el usuario marcó opciones de este
 * partido para su combinada, se comparten esas; si no, las más probables, una
 * por familia de mercado para no repetir cuatro líneas casi idénticas.
 */
export function sharePicksFromAnalysis(analysis, selected = null) {
  if (!analysis) return [];
  const shape = (pick) => ({
    id: String(pick.id || ''),
    name: String(pick.name || pick.pick || '').trim(),
    probability: percentOf(pick),
    odd: Number(pick.odd) > 1 ? Number(pick.odd) : null,
    bookmaker: pick.bookmaker || null,
    category: String(pick.category || pick.id || ''),
  });
  if (analysis.access === 'free') {
    const visible = analysis.freePreview?.selection;
    return visible?.name ? [shape(visible)] : [];
  }
  const catalog = (analysis.combinada?.selectable || analysis.combinada?.selections || [])
    .map(shape).filter((pick) => pick.name && pick.probability != null);
  const chosen = selected ? catalog.filter((pick) => selected[pick.id]) : [];
  if (chosen.length) return chosen.slice(0, MAX_PICKS);
  const byFamily = new Map();
  for (const pick of [...catalog].sort((left, right) => right.probability - left.probability || (right.odd || 0) - (left.odd || 0))) {
    // "total-209.5", "handicap-7.5"… comparten familia aunque cambie la línea.
    const family = pick.category.replace(/-?m?\d+(?:[._]\d+)?$/, '') || pick.category;
    if (!byFamily.has(family)) byFamily.set(family, pick);
  }
  return [...byFamily.values()].slice(0, MAX_PICKS);
}

// Los escudos de cdn.nba.com no envían cabecera CORS y no se pueden copiar a
// un lienzo. ESPN sirve los mismos escudos con CORS abierto; se cruzan por el
// ID oficial de la franquicia, que va dentro de la URL del escudo.
const ESPN_NBA_LOGO_BY_TEAM_ID = {
  1610612737: 'atl', 1610612738: 'bos', 1610612751: 'bkn', 1610612766: 'cha', 1610612741: 'chi',
  1610612739: 'cle', 1610612742: 'dal', 1610612743: 'den', 1610612765: 'det', 1610612744: 'gs',
  1610612745: 'hou', 1610612754: 'ind', 1610612746: 'lac', 1610612747: 'lal', 1610612763: 'mem',
  1610612748: 'mia', 1610612749: 'mil', 1610612750: 'min', 1610612740: 'no', 1610612752: 'ny',
  1610612760: 'okc', 1610612753: 'orl', 1610612755: 'phi', 1610612756: 'phx', 1610612757: 'por',
  1610612758: 'sac', 1610612759: 'sa', 1610612761: 'tor', 1610612762: 'utah', 1610612764: 'wsh',
};

export function shareableLogoUrl(team) {
  const logo = team?.logo || null;
  if (!logo) return null;
  const nbaTeamId = String(logo).match(/^https:\/\/cdn\.nba\.com\/logos\/nba\/(\d+)\//)?.[1];
  if (nbaTeamId) {
    const code = ESPN_NBA_LOGO_BY_TEAM_ID[nbaTeamId];
    return code ? `https://a.espncdn.com/i/teamlogos/nba/500/${code}.png` : null;
  }
  return logo;
}

function loadImage(src, { crossOrigin = true, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    const image = new Image();
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    // Sin CORS el escudo "mancharía" el lienzo y no se podría exportar: si el
    // servidor del escudo no lo permite, la carga falla y se usan iniciales.
    if (crossOrigin) image.crossOrigin = 'anonymous';
    image.onload = () => done(image.naturalWidth > 0 ? image : null);
    image.onerror = () => done(null);
    setTimeout(() => done(null), timeoutMs);
    image.src = src;
  });
}

function wrapText(context, text, maxWidth, maxLines = 3) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth || !line) line = candidate;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && context.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return words.length === 1 ? words[0].slice(0, 2).toUpperCase() : `${words[0][0]}${words.at(-1)[0]}`.toUpperCase();
}

function drawCrest(context, image, name, centerX, centerY, accent) {
  const size = 150;
  roundRect(context, centerX - size / 2, centerY - size / 2, size, size, 34);
  context.fillStyle = 'rgba(255,255,255,0.05)';
  context.fill();
  context.strokeStyle = `${accent}66`;
  context.lineWidth = 2;
  context.stroke();
  if (image) {
    const box = size - 38;
    const scale = Math.min(box / image.naturalWidth, box / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.drawImage(image, centerX - width / 2, centerY - height / 2, width, height);
    return;
  }
  context.fillStyle = accent;
  context.font = `700 54px ${FONT}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(initials(name), centerX, centerY + 2);
}

function centerLabel(match, timeZone) {
  const status = String(match?.fixture?.status?.short || 'NS');
  const home = match?.goals?.home;
  const away = match?.goals?.away;
  const hasScore = (FINAL.has(status) || LIVE.has(status) || /^IN\d*$/.test(status)) && home != null && away != null;
  if (hasScore) return { main: `${home} – ${away}`, sub: FINAL.has(status) ? 'FINALIZADO' : 'EN VIVO', live: !FINAL.has(status) };
  const date = new Date(match?.fixture?.date);
  if (Number.isNaN(date.getTime())) return { main: 'VS', sub: '' };
  return {
    main: date.toLocaleTimeString('es', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }),
    sub: date.toLocaleDateString('es', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase(),
  };
}

/** Dibuja la tarjeta y devuelve el PNG como Blob. */
export async function renderShareCard({ match, picks = [], timeZone = 'UTC' }) {
  const [logo, homeCrest, awayCrest] = await Promise.all([
    loadImage('/logo-cf.png', { crossOrigin: false, timeoutMs: 2500 }),
    loadImage(shareableLogoUrl(match?.teams?.home)),
    loadImage(shareableLogoUrl(match?.teams?.away)),
    typeof document !== 'undefined' && document.fonts?.ready ? document.fonts.ready.catch(() => null) : null,
  ]);

  const measure = document.createElement('canvas').getContext('2d');
  const innerWidth = WIDTH - PAD * 2;
  const pickNameWidth = innerWidth - 64;
  measure.font = `600 38px ${FONT}`;
  const rows = picks.slice(0, MAX_PICKS).map((pick) => {
    const lines = wrapText(measure, pick.name, pickNameWidth, 3);
    return { pick, lines, height: 40 + lines.length * 50 + 78 };
  });
  measure.font = `700 46px ${FONT}`;
  const teamWidth = innerWidth / 2 - 150;
  const homeLines = wrapText(measure, match?.teams?.home?.name || 'Local', teamWidth, 2);
  const awayLines = wrapText(measure, match?.teams?.away?.name || 'Visitante', teamWidth, 2);
  const teamTextHeight = Math.max(homeLines.length, awayLines.length) * 56;

  const headerHeight = 190;
  const matchHeight = 250 + teamTextHeight + 50;
  const rowsHeight = rows.length
    ? rows.reduce((sum, row) => sum + row.height, 0) + (rows.length - 1) * 22 + 84
    : 130;
  const footerHeight = 120;
  const height = headerHeight + matchHeight + rowsHeight + footerHeight;

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = height;
  const context = canvas.getContext('2d');

  const background = context.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, COLOR.bg0);
  background.addColorStop(0.5, COLOR.bg1);
  background.addColorStop(1, COLOR.bg0);
  context.fillStyle = background;
  context.fillRect(0, 0, WIDTH, height);

  // ── Cabecera ──
  let y = 56;
  if (logo) {
    const logoHeight = 84;
    const logoWidth = logo.naturalWidth * (logoHeight / logo.naturalHeight);
    context.drawImage(logo, (WIDTH - logoWidth) / 2, y, logoWidth, logoHeight);
  } else {
    context.fillStyle = COLOR.green;
    context.font = `700 54px ${FONT}`;
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.fillText('CF ANÁLISIS', WIDTH / 2, y + 12);
  }
  y = headerHeight;

  // ── Partido ──
  roundRect(context, PAD, y, innerWidth, matchHeight - 34, 34);
  context.fillStyle = COLOR.surface;
  context.fill();
  context.strokeStyle = COLOR.border;
  context.lineWidth = 2;
  context.stroke();

  context.fillStyle = COLOR.muted;
  context.font = `500 30px ${FONT}`;
  context.textAlign = 'center';
  context.textBaseline = 'top';
  const league = wrapText(context, match?.league?.name || '', innerWidth - 80, 1)[0] || '';
  context.fillText(league, WIDTH / 2, y + 30);

  const crestY = y + 160;
  const homeX = PAD + innerWidth / 4 - 30;
  const awayX = PAD + (innerWidth * 3) / 4 + 30;
  drawCrest(context, homeCrest, match?.teams?.home?.name, homeX, crestY, COLOR.green);
  drawCrest(context, awayCrest, match?.teams?.away?.name, awayX, crestY, COLOR.cyan);

  const center = centerLabel(match, timeZone);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = COLOR.text;
  context.font = `700 68px ${FONT}`;
  context.fillText(center.main, WIDTH / 2, crestY - 6);
  if (center.sub) {
    context.fillStyle = center.live ? COLOR.green : COLOR.faint;
    context.font = `600 24px ${FONT}`;
    context.fillText(center.sub, WIDTH / 2, crestY + 52);
  }

  context.fillStyle = COLOR.text;
  context.font = `700 46px ${FONT}`;
  context.textBaseline = 'top';
  homeLines.forEach((line, index) => context.fillText(line, homeX, crestY + 104 + index * 56));
  awayLines.forEach((line, index) => context.fillText(line, awayX, crestY + 104 + index * 56));
  y += matchHeight;

  // ── Opciones ──
  if (rows.length) {
    context.fillStyle = COLOR.green;
    context.font = `700 28px ${FONT}`;
    context.textAlign = 'left';
    context.textBaseline = 'top';
    context.fillText(rows.length === 1 ? 'OPCIÓN RECOMENDADA' : 'OPCIONES RECOMENDADAS', PAD + 4, y);
    y += 62;
    for (const row of rows) {
      roundRect(context, PAD, y, innerWidth, row.height, 26);
      context.fillStyle = COLOR.surface;
      context.fill();
      context.strokeStyle = COLOR.border;
      context.stroke();
      context.fillStyle = COLOR.text;
      context.font = `600 38px ${FONT}`;
      context.textAlign = 'left';
      context.textBaseline = 'top';
      row.lines.forEach((line, index) => context.fillText(line, PAD + 32, y + 30 + index * 50));
      let chipX = PAD + 32;
      const chipY = y + 40 + row.lines.length * 50;
      const chip = (label, value, color) => {
        context.font = `600 22px ${FONT}`;
        const labelWidth = context.measureText(label).width;
        context.font = `700 36px ${FONT}`;
        const valueWidth = context.measureText(value).width;
        const width = labelWidth + valueWidth + 52;
        roundRect(context, chipX, chipY, width, 56, 14);
        context.fillStyle = 'rgba(255,255,255,0.05)';
        context.fill();
        context.strokeStyle = `${color}55`;
        context.stroke();
        context.textBaseline = 'middle';
        context.fillStyle = COLOR.faint;
        context.font = `600 22px ${FONT}`;
        context.fillText(label, chipX + 18, chipY + 29);
        context.fillStyle = color;
        context.font = `700 36px ${FONT}`;
        context.fillText(value, chipX + 30 + labelWidth, chipY + 29);
        chipX += width + 16;
      };
      if (row.pick.probability != null) chip('PROB', `${row.pick.probability}%`, COLOR.green);
      if (row.pick.odd) chip('CUOTA', row.pick.odd.toFixed(2), COLOR.amber);
      if (row.pick.bookmaker) {
        context.fillStyle = COLOR.muted;
        context.font = `500 26px ${FONT}`;
        context.textBaseline = 'middle';
        context.fillText(String(row.pick.bookmaker), chipX + 6, chipY + 29);
      }
      y += row.height + 22;
    }
  } else {
    context.fillStyle = COLOR.muted;
    context.font = `500 32px ${FONT}`;
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.fillText('Mira el análisis completo de este partido', WIDTH / 2, y + 24);
  }

  // ── Pie ──
  const footerY = height - footerHeight + 22;
  context.strokeStyle = COLOR.border;
  context.beginPath();
  context.moveTo(PAD, footerY);
  context.lineTo(WIDTH - PAD, footerY);
  context.stroke();
  context.textAlign = 'center';
  context.textBaseline = 'top';
  context.fillStyle = COLOR.green;
  context.font = `700 30px ${FONT}`;
  context.fillText('CFANALISIS.COM', WIDTH / 2, footerY + 22);
  context.fillStyle = COLOR.faint;
  context.font = `400 22px ${FONT}`;
  context.fillText('Análisis estadístico, no consejo financiero', WIDTH / 2, footerY + 62);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('No se pudo generar la imagen'))), 'image/png');
  });
}

function fileSlug(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'partido';
}

/**
 * Genera la imagen y abre la hoja de compartir. Donde el navegador no admite
 * compartir archivos (algunos escritorios), descarga el PNG.
 * Devuelve 'shared', 'downloaded' o 'cancelled'.
 */
export async function shareMatchCard({ match, picks = [], timeZone = 'UTC' }) {
  const blob = await renderShareCard({ match, picks, timeZone });
  const home = match?.teams?.home?.name || 'Local';
  const away = match?.teams?.away?.name || 'Visitante';
  const fileName = `cfanalisis-${fileSlug(home)}-vs-${fileSlug(away)}.png`;
  const file = new File([blob], fileName, { type: 'image/png' });
  const title = `${home} vs ${away}`;
  if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text: `${title} · CF Análisis` });
      return 'shared';
    } catch (error) {
      if (error?.name === 'AbortError') return 'cancelled';
      // NotAllowedError u otro fallo de la hoja nativa: cae a la descarga.
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}
