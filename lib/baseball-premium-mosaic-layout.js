export const BASEBALL_MOSAIC_WIDTH = 1920;
export const BASEBALL_MOSAIC_HEIGHT = 1080;
export const BASEBALL_MOSAIC_CARDS_PER_PAGE = 4;
export const BASEBALL_MOSAIC_OPTIONS_PER_CARD = 10;

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
  const pages = chunks(cards, BASEBALL_MOSAIC_CARDS_PER_PAGE);
  return pages.map((pageCards, index) => ({
    page: index + 1,
    pages: pages.length,
    cards: pageCards,
  }));
}

export function baseballMosaicPageCount(match, groupOrder, groupLabels) {
  return buildBaseballMosaicPages(match, groupOrder, groupLabels).length;
}
