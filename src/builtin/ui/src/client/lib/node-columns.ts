/**
 * The details view's columns and their widths, which a person sets by
 * dragging the edges of the column names.
 *
 * The name column is a minimum that also takes whatever width is left over,
 * so the listing always fills its pane; the others are exactly as wide as set.
 */

export const DETAIL_COLUMN_LABELS = ['Name', 'Type', 'Size', 'Mode', 'Owner', 'Group', 'Modified'] as const;

/** In pixels, in the order of `DETAIL_COLUMN_LABELS`. */
export const DEFAULT_COLUMN_WIDTHS: readonly number[] = [224, 176, 88, 104, 96, 96, 176];

const MIN_COLUMN_WIDTH = 48;
const MAX_COLUMN_WIDTH = 960;
/** The gap between columns and the row's padding at each side, as the rows draw them. */
const COLUMN_GAP = 12;
const ROW_PADDING = 6;

const clampColumnWidth = (width: number): number => Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width)));

/** Stored widths, or the defaults for anything that is not a full set of numbers. */
export function parseColumnWidths(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length !== DEFAULT_COLUMN_WIDTHS.length || !raw.every((width) => typeof width === 'number' && Number.isFinite(width))) {
    return [...DEFAULT_COLUMN_WIDTHS];
  }
  return raw.map(clampColumnWidth);
}

/** The rows' and header's `grid-template-columns`. */
export const columnTemplate = (widths: readonly number[]): string => widths.map((width, index) => index === 0 ? `minmax(${width}px, 1fr)` : `${width}px`).join(' ');

/** The listing's narrowest: every column at its width, with the gaps and padding; wider panes give the rest to the name. */
export const columnsMinWidth = (widths: readonly number[]): number => widths.reduce((sum, width) => sum + width, 0) + (widths.length - 1) * COLUMN_GAP + 2 * ROW_PADDING;

/** One column's width changed, the rest kept. */
export const withColumnWidth = (widths: readonly number[], index: number, width: number): number[] => widths.map((each, at) => at === index ? clampColumnWidth(width) : each);
