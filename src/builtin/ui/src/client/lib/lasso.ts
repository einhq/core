/**
 * A lasso over a page of tiles and sections: the band a drag draws, what it takes, and how fast the
 * page scrolls under it near the window's edge. Pure, so every rule is tested without a page;
 * `useLasso` draws the band and calls the page once a frame.
 *
 * A frame must not read the layout of each tile: hit tests run on boxes the page already holds
 * (a grid's `onLayout`, a stream's arithmetic), and a grid's boxes are indexed by row once
 * (`tileIndex`), so a band over a group of thousands is a binary search and the tiles it crosses.
 */
import type { SectionSelection } from './section-selection.ts';
import { setItems, setSections } from './section-selection.ts';

/** A rectangle in px, edges inclusive. */
export type LassoRect = { left: number; top: number; right: number; bottom: number };

/** Replace what is selected, add to it (Shift held as the lasso starts) or take from it (Alt). */
export type LassoMode = 'replace' | 'add' | 'remove';

/** How far the pointer moves before a press becomes a lasso rather than a click. */
const LASSO_THRESHOLD = 4;
/** Within this many px of the window's top or bottom edge the page scrolls under the lasso. */
const LASSO_EDGE = 48;
/** The fastest it scrolls, at the very edge, in px a second. */
const LASSO_MAX_SPEED = 1200;

export const lassoMode = (keys: { shiftKey: boolean; altKey: boolean }): LassoMode => keys.altKey ? 'remove' : keys.shiftKey ? 'add' : 'replace';

/** The band between where the pointer went down and where it is now, whichever way it was drawn. */
export const bandRect = (from: { x: number; y: number }, to: { x: number; y: number }): LassoRect => ({
  left: Math.min(from.x, to.x),
  top: Math.min(from.y, to.y),
  right: Math.max(from.x, to.x),
  bottom: Math.max(from.y, to.y),
});

/** Whether the pointer has moved far enough from where it went down to draw a band. */
export const pastThreshold = (from: { x: number; y: number }, to: { x: number; y: number }): boolean => Math.hypot(to.x - from.x, to.y - from.y) >= LASSO_THRESHOLD;

/**
 * How fast the page scrolls with the pointer at `y`, in px a second: up (negative) within `edge`
 * px under `top`, down within `edge` px over `bottom`, faster the nearer the edge, at most `max`.
 */
export function edgeSpeed(y: number, top: number, bottom: number, edge = LASSO_EDGE, max = LASSO_MAX_SPEED): number {
  if (y < top + edge) return -max * Math.min(1, (top + edge - y) / edge);
  if (y > bottom - edge) return max * Math.min(1, (y - (bottom - edge)) / edge);
  return 0;
}

const intersects = (a: LassoRect, b: LassoRect): boolean => a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;

const overlapArea = (a: LassoRect, b: LassoRect): number =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/** Whether the band covers at least `share` of `rect`'s area. */
const covers = (band: LassoRect, rect: LassoRect, share = 0.5): boolean => {
  const area = (rect.right - rect.left) * (rect.bottom - rect.top);
  return area > 0 && overlapArea(band, rect) >= share * area;
};

/**
 * Whether a closed section is taken whole: the band touches its header, or covers at least half of
 * its strip of pictures.
 */
export const sectionHit = (band: LassoRect, section: { header: LassoRect; strip: LassoRect }): boolean => intersects(band, section.header) || covers(band, section.strip);

/** A tile's box, in px from its grid's top left. */
export type LassoBox = { left: number; top: number; width: number; height: number };

/** A grid's tiles by row: each row's span down the grid and its tiles, which run left to right. */
export type TileIndex = { boxes: readonly LassoBox[]; rows: { top: number; bottom: number; start: number; end: number }[] };

/** Tiles whose tops differ by less than this share a row. */
const ROW_SLACK = 2;

/**
 * The tiles of a grid, in reading order, indexed by row. Built once per layout; a band is then
 * looked up by `tilesInRect` without a pass over every tile.
 */
export function tileIndex(boxes: readonly LassoBox[]): TileIndex {
  const rows: TileIndex['rows'] = [];
  boxes.forEach((box, index) => {
    const row = rows[rows.length - 1];
    if (row && Math.abs(boxes[row.start].top - box.top) < ROW_SLACK && box.left >= boxes[row.end - 1].left) {
      row.end = index + 1;
      row.bottom = Math.max(row.bottom, box.top + box.height);
    } else rows.push({ top: box.top, bottom: box.top + box.height, start: index, end: index + 1 });
  });
  return { boxes, rows };
}

/** The first index in [low, high) for which `past` holds, `past` being false then true along it. */
const firstPast = (low: number, high: number, past: (index: number) => boolean): number => {
  while (low < high) {
    const middle = (low + high) >> 1;
    if (past(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
};

/** The indexes of the tiles `rect` touches, in reading order. */
export function tilesInRect(index: TileIndex, rect: LassoRect): number[] {
  const hits: number[] = [];
  const { rows, boxes } = index;
  // Rows are stacked down the grid, so their bottoms rise in order.
  for (let at = firstPast(0, rows.length, (row) => rows[row].bottom >= rect.top); at < rows.length && rows[at].top <= rect.bottom; at++) {
    const row = rows[at];
    for (let tile = firstPast(row.start, row.end, (each) => boxes[each].left + boxes[each].width >= rect.left); tile < row.end; tile++) {
      const box = boxes[tile];
      if (box.left > rect.right) break;
      if (box.top <= rect.bottom && box.top + box.height >= rect.top) hits.push(tile);
    }
  }
  return hits;
}

/** What a band takes: sections whole, and items one by one, each with its section. */
export type LassoHits = { sections: ReadonlySet<string>; items: ReadonlyMap<string, string> };

/** Whether two bands took the same, so a frame that changes nothing selects nothing anew. */
export const sameHits = (a: LassoHits, b: LassoHits): boolean =>
  a.sections.size === b.sections.size && a.items.size === b.items.size && [...a.sections].every((section) => b.sections.has(section)) &&
  [...a.items.keys()].every((path) => b.items.has(path));

/**
 * The selection a lasso leaves, from `base`, what was selected when it started: replaced by what
 * it took, with that added, or with that taken out.
 */
export function lassoSelection(base: SectionSelection, hits: LassoHits, mode: LassoMode): SectionSelection {
  let next: SectionSelection = mode === 'replace' ? { sections: new Set(), items: new Map(), excluded: new Map() } : base;
  const on = mode !== 'remove';
  if (hits.sections.size > 0) next = setSections(next, hits.sections, on);
  const bySection = new Map<string, string[]>();
  for (const [path, section] of hits.items) {
    const list = bySection.get(section);
    if (list) list.push(path);
    else bySection.set(section, [path]);
  }
  for (const [section, paths] of bySection) next = setItems(next, section, paths, on);
  return next;
}
