/**
 * The geometry of a stream of sections that are all one height until opened.
 *
 * A closed section has a fixed height, so where any section starts is arithmetic: its index
 * times the closed height and the gap, plus what every open section above it adds over that
 * height. Only the open ones are measured, and there are few, so the offsets, the total height
 * and which sections a band of the page crosses all come from a short sorted list rather than
 * from a pass over every section. Pure and UI-free, for `SectionStream` and its tests.
 */

export type StreamLayout = {
  count: number;
  /** A closed section's height, in px. */
  closedHeight: number;
  /** Between two sections, in px. */
  gap: number;
  /** The open sections' indexes, ascending. */
  openIndexes: number[];
  /** Each open section's height, by position in `openIndexes`. */
  openHeights: number[];
  /** What the open sections before each position in `openIndexes` add over the closed height. */
  extraBefore: number[];
};

/**
 * The layout of `count` sections `closedHeight` tall, `gap` apart, with the open ones at the
 * heights in `open` (index → height). An index outside the stream is ignored.
 */
export function streamLayout(count: number, closedHeight: number, gap: number, open: ReadonlyMap<number, number>): StreamLayout {
  const openIndexes = [...open.keys()].filter((index) => index >= 0 && index < count).sort((a, b) => a - b);
  const openHeights = openIndexes.map((index) => Math.max(0, open.get(index)!));
  const extraBefore: number[] = [];
  let extra = 0;
  for (const height of openHeights) {
    extraBefore.push(extra);
    extra += height - closedHeight;
  }
  return { count, closedHeight, gap, openIndexes, openHeights, extraBefore };
}

/** How many open sections lie before `index`: a binary search over the open list. */
const openBefore = (layout: StreamLayout, index: number): number => {
  let low = 0;
  let high = layout.openIndexes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (layout.openIndexes[middle] < index) low = middle + 1;
    else high = middle;
  }
  return low;
};

/** What the open sections before `index` add over the closed height. */
const extraAbove = (layout: StreamLayout, index: number): number => {
  const before = openBefore(layout, index);
  if (before === 0) return 0;
  const last = before - 1;
  return layout.extraBefore[last] + layout.openHeights[last] - layout.closedHeight;
};

/** The height of section `index`: measured when open, the closed height otherwise. */
export function sectionHeight(layout: StreamLayout, index: number): number {
  const at = openBefore(layout, index);
  return layout.openIndexes[at] === index ? layout.openHeights[at] : layout.closedHeight;
}

/** Where section `index` starts, from the top of the stream. */
export function sectionTop(layout: StreamLayout, index: number): number {
  return index * (layout.closedHeight + layout.gap) + extraAbove(layout, index);
}

/** The whole stream's height, without a trailing gap. */
export function streamHeight(layout: StreamLayout): number {
  if (layout.count === 0) return 0;
  return sectionTop(layout, layout.count - 1) + sectionHeight(layout, layout.count - 1);
}

/**
 * The sections a band of the stream crosses, `top` to `bottom` in stream coordinates, as a
 * half-open range; empty when the band misses every section.
 */
export function sectionsInBand(layout: StreamLayout, top: number, bottom: number): { start: number; end: number } {
  if (layout.count === 0 || !Number.isFinite(top) || !Number.isFinite(bottom) || bottom < top) return { start: 0, end: 0 };
  // The first section whose bottom reaches the band, then the first that starts after it.
  let low = 0;
  let high = layout.count;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sectionTop(layout, middle) + sectionHeight(layout, middle) < top) low = middle + 1;
    else high = middle;
  }
  const start = low;
  high = layout.count;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sectionTop(layout, middle) <= bottom) low = middle + 1;
    else high = middle;
  }
  return { start, end: Math.max(start, low) };
}

/**
 * The section lying across `y`, in stream coordinates: the one it falls in, or the next one when
 * it falls in a gap. Undefined past the last section.
 */
export function sectionAt(layout: StreamLayout, y: number): number | undefined {
  const { start, end } = sectionsInBand(layout, y, y);
  if (start < end) return start;
  return start < layout.count ? start : undefined;
}

/**
 * How far to scroll so a section stays where it is on screen when the stream changes around it:
 * `index` in `before` and `afterIndex` in `after` name the same section. A section above it that
 * opened, closed, grew or went away moves it by exactly the difference, and nothing below it
 * moves it at all.
 */
export function holdOffset(before: StreamLayout, index: number, after: StreamLayout, afterIndex: number): number {
  return sectionTop(after, afterIndex) - sectionTop(before, index);
}
