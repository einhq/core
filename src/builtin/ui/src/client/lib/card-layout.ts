/**
 * Geometry for a grid of uniform cards.
 *
 * The media grid packs rows from aspect ratios, so its layout is a fold over the
 * items. Cards are all the same shape, so theirs is arithmetic: a column count
 * from the width, one height for every card, and a row offset that is a
 * multiplication. That is what makes the whole grid measurable without touching
 * an item — a page can put its exact height in the document and mount only the
 * rows near the viewport.
 */

/** Cover box shape, mirroring `COVER_ASPECT` in EntityCard. */
const COVER_ASPECT = 3 / 2;

/**
 * Which optional lines of `EntityCard`'s text block a card draws. The title is
 * always there, and always reserved at its two-line clamp: whether a title
 * wraps depends on the font, which only the browser knows.
 */
export type CardTextParts = { date?: boolean; description?: boolean; badges?: boolean };

// EntityCard's text block, part by part, at the app theme's scale (theme.ts:
// spacing sm 11, md 15; line heights md 1.5, xs 1.35).
/** `mt='sm'` between the cover and the title. */
const TEXT_TOP = 11;
/** Two clamped lines of 16px text. */
const TEXT_TITLE = 2 * 16 * 1.5;
/** A stack gap and one 12px line. */
const TEXT_DATE = 4 + 12 * 1.35;
/** A stack gap and two clamped 12px lines. */
const TEXT_DESCRIPTION = 4 + 2 * 12 * 1.35;
/** A stack gap, the row's 2px top padding and one 16px badge row. */
const TEXT_BADGES = 4 + 2 + 16;
/** The card's own `md` padding under the text. */
const TEXT_BOTTOM = 15;

/**
 * Height of everything below the cover, for a card drawing these parts.
 *
 * A grid gives every card the same height, the height its fullest card needs,
 * which is what lets a row offset be computed rather than measured — so a grid
 * of people with nothing but names is not padded out to the height of a card
 * with a date, a description and badges. A badge row that wraps is the one
 * thing this cannot see; `CardGrid` grows to fit a card that reports it
 * overflows (`useCardFit`).
 */
export function cardTextHeight(parts: CardTextParts): number {
  return Math.ceil(
    TEXT_TOP + TEXT_TITLE + (parts.date ? TEXT_DATE : 0) + (parts.description ? TEXT_DESCRIPTION : 0) + (parts.badges ? TEXT_BADGES : 0) + TEXT_BOTTOM,
  );
}

/** The fullest card: what a grid reserves when it cannot say what its cards hold. */
export const CARD_TEXT_HEIGHT = cardTextHeight({ date: true, description: true, badges: true });

/** Every part any of the items draws. Stops looking once all of them are in. */
export function textPartsOf<T>(items: readonly T[], partsOf: (item: T) => CardTextParts): CardTextParts {
  const union: CardTextParts = {};
  for (const item of items) {
    const parts = partsOf(item);
    if (parts.date) union.date = true;
    if (parts.description) union.description = true;
    if (parts.badges) union.badges = true;
    if (union.date && union.description && union.badges) break;
  }
  return union;
}

/** Gutter between cards. */
export const CARD_GAP = 16;

/** Narrowest a card may get before the grid drops a column. */
export const CARD_MIN_WIDTH = 210;

/** Never more than this many columns, however wide the window is. */
export const CARD_MAX_COLUMNS = 6;

/**
 * How narrow a card may get to keep a phone at two columns.
 *
 * `CARD_MIN_WIDTH` alone gives every phone one column — a 390px screen has
 * ~358px to fill — and a single card the width of the screen is a poster, not a
 * grid: one album per screenful. Two narrower cards still carry a readable
 * cover and a two-line title, so below the width where two full cards fit the
 * grid squeezes to two before it gives up and drops to one. 130 keeps a 320px
 * screen (288px of content) at two.
 */
export const CARD_PHONE_MIN_WIDTH = 130;

export type CardLayout = {
  columns: number;
  /** Width of one card, the container width less gutters, split evenly. */
  cardWidth: number;
  /** Cover plus text block — the same for every card in the grid. */
  cardHeight: number;
  rows: number;
  /** Full height of the grid, which the page puts in the document. */
  height: number;
};

/** How many columns fit, clamped so a card never gets narrower than it reads well at. */
export function columnsForWidth(width: number, minWidth = CARD_MIN_WIDTH, gap = CARD_GAP): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  const fit = Math.floor((width + gap) / (minWidth + gap));
  if (fit < 2 && width + gap >= 2 * (CARD_PHONE_MIN_WIDTH + gap)) return 2;
  return Math.min(CARD_MAX_COLUMNS, Math.max(1, fit));
}

/**
 * The grid's geometry. `minCardHeight` is what a mounted card has reported it
 * needs, which wins over the arithmetic when it is taller.
 */
export function cardLayout(count: number, width: number, gap = CARD_GAP, textHeight = CARD_TEXT_HEIGHT, minCardHeight = 0): CardLayout {
  const columns = columnsForWidth(width, CARD_MIN_WIDTH, gap);
  const cardWidth = Math.max(0, (width - gap * (columns - 1)) / columns);
  // Whole pixels: the grid paints its empty slots as a mask repeated once per row
  // (`CardGrid`), and a fractional row would drift from the cards over a long grid.
  const cardHeight = Math.ceil(Math.max(cardWidth / COVER_ASPECT + textHeight, minCardHeight));
  const rows = Math.max(0, Math.ceil(count / columns));
  // No trailing gutter: n rows have n-1 gaps between them.
  const height = rows === 0 ? 0 : rows * cardHeight + (rows - 1) * gap;

  return { columns, cardWidth, cardHeight, rows, height };
}

/** Where a card sits, in the grid's own coordinates. */
export function cardPosition(index: number, layout: CardLayout, gap = CARD_GAP): { top: number; left: number } {
  const row = Math.floor(index / layout.columns);
  const column = index % layout.columns;
  return {
    top: row * (layout.cardHeight + gap),
    left: column * (layout.cardWidth + gap),
  };
}

/**
 * The half-open range of cards intersecting a vertical band.
 *
 * Rows are uniform, so this is division rather than a search. The band comes
 * from `useVerticalWindow` and already carries its overscan.
 */
export function cardRangeForVerticalWindow(
  count: number,
  layout: CardLayout,
  window: { top: number; bottom: number } | undefined,
  gap = CARD_GAP,
): { start: number; end: number } {
  if (count === 0 || layout.columns === 0) return { start: 0, end: 0 };
  // No window measured yet — the first pass mounts nothing rather than everything.
  if (!window) return { start: 0, end: 0 };

  const stride = layout.cardHeight + gap;
  if (stride <= 0) return { start: 0, end: count };

  const firstRow = Math.max(0, Math.floor(window.top / stride));
  const lastRow = Math.min(layout.rows - 1, Math.floor((window.bottom - 1) / stride));
  if (lastRow < firstRow) return { start: 0, end: 0 };

  return {
    start: firstRow * layout.columns,
    end: Math.min(count, (lastRow + 1) * layout.columns),
  };
}
