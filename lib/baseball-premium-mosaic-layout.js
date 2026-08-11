export const BASEBALL_MOSAIC_WIDTH = 2560;
export const BASEBALL_MOSAIC_HEIGHT = 1440;
export const BASEBALL_MOSAIC_OPTIONS_PER_CARD = 6;

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export function buildBaseballMosaicCards(match, groupOrder, groupLabels) {
  const cards = [];
  for (const family of groupOrder) {
    const options = Array.isArray(match?.groups?.[family]) ? match.groups[family] : [];
    const parts = chunks(options, BASEBALL_MOSAIC_OPTIONS_PER_CARD);
    for (let index = 0; index < parts.length; index += 1) {
      cards.push({
        family,
        label: groupLabels[family] || family.toUpperCase(),
        part: index + 1,
        parts: parts.length,
        options: parts[index],
      });
    }
  }
  return cards;
}

export function buildBaseballMosaicPages(match, groupOrder, groupLabels) {
  const cards = buildBaseballMosaicCards(match, groupOrder, groupLabels);
  if (!cards.length) return [];
  return [{ page: 1, pages: 1, cards }];
}

export function baseballMosaicPageCount(match, groupOrder, groupLabels) {
  return buildBaseballMosaicCards(match, groupOrder, groupLabels).length ? 1 : 0;
}

export function baseballMosaicGrid(cardCount) {
  const count = Math.max(1, Number(cardCount) || 1);
  let columns;
  if (count === 1) columns = 1;
  else if (count <= 4) columns = 2;
  else if (count <= 6) columns = 3;
  else if (count <= 12) columns = 4;
  else columns = Math.ceil(Math.sqrt(count * 4 / 3));
  return { columns, rows: Math.ceil(count / columns) };
}
