/**
 * Justified (row-based) media layout.
 *
 * Rows are filled to the container width with the pictures' own aspect ratios: aim
 * for a row height, take items until the row is full, then scale the row's height so
 * its widths sum to exactly the container. The last row stays ragged unless it already
 * occupies more than 80% of the width, where filling the small remainder looks better.
 *
 * Pure and UI-free — it takes aspect ratios, not media items — so the grid, the
 * loading skeleton and the unit tests all drive the same code.
 */

/** Assumed shape when a file has no stored dimensions yet. 3:2 is the commonest camera frame. */
export const DEFAULT_ASPECT = 3 / 2;

/**
 * A nearly full final row is justified rather than leaving a small accidental-looking gap.
 * Exactly 80% remains ragged: the product rule is deliberately "more than 80%".
 */
export const LAST_ROW_FILL_THRESHOLD = 0.8;

/** Nothing narrower than 1:2 or wider than 3:1 gets to dictate a row height. */
const MIN_ASPECT = 0.5;
const MAX_ASPECT = 3;

type JustifiedOptions = {
  containerWidth: number;
  targetRowHeight: number;
  /** Gutter between tiles, both axes. */
  gap: number;
  /** Best-effort floor for a scaled row. Default `targetRowHeight * 0.65`. */
  minRowHeight?: number;
  /** Ceiling for a scaled row. Default `targetRowHeight * 1.6`. */
  maxRowHeight?: number;
  minAspect?: number;
  maxAspect?: number;
  /**
   * Fixed count per row instead of filling to `targetRowHeight`. Every row — the last
   * one included, however few items it has — is scaled to the container width, so a
   * lone trailing item spans the row alone. `targetRowHeight` only seeds the skeleton.
   */
  itemsPerRow?: number;
};

type JustifiedTile = {
  /** Index into the input array — the layout never reorders. */
  index: number;
  row: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

type JustifiedRow = {
  top: number;
  height: number;
  firstIndex: number;
  count: number;
};

type JustifiedLayout = {
  tiles: JustifiedTile[];
  rows: JustifiedRow[];
  /** Total height of the grid, without a trailing gutter. */
  height: number;
};

/** A contiguous, half-open slice of the input tiles. */
type JustifiedTileRange = {
  firstIndex: number;
  afterLastIndex: number;
};

const EMPTY: JustifiedLayout = { tiles: [], rows: [], height: 0 };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * Find the contiguous run of tiles whose rows overlap a vertical interval.
 *
 * Rows and their tile indices are both ordered, so a grid can render this range without
 * building a per-tile visibility structure. The binary searches keep the scroll path
 * cheap even for an album with many thousands of rows.
 */
export function tileRangeForVerticalWindow(
  rows: readonly JustifiedRow[],
  top: number,
  bottom: number,
): JustifiedTileRange | undefined {
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom < top || rows.length === 0) return undefined;

  // First row whose bottom reaches the window.
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const row = rows[middle];
    if (row.top + row.height < top) low = middle + 1;
    else high = middle;
  }
  const firstRow = low;
  if (firstRow === rows.length) return undefined;

  // First row beginning after the window; the preceding row is the last overlap.
  low = firstRow;
  high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].top <= bottom) low = middle + 1;
    else high = middle;
  }
  const afterLastRow = low;
  if (afterLastRow === firstRow) return undefined;

  const first = rows[firstRow];
  const last = rows[afterLastRow - 1];
  return {
    firstIndex: first.firstIndex,
    afterLastIndex: last.firstIndex + last.count,
  };
}

/**
 * Row height to aim for at a given container width.
 *
 * A phone does not use it for the grid itself — it lays out a fixed two per row, see
 * `defaultItemsPerRow` — so the phone value only sizes the loading skeleton's reserve.
 * A tablet shows about three pictures per row, a desktop about five.
 */
export function defaultRowHeight(containerWidth: number): number {
  if (containerWidth < 640) return 210;
  if (containerWidth < 1024) return 170;
  return 200;
}

/**
 * Fixed column count at a given container width, or `undefined` for a justified fill.
 *
 * A phone is too narrow for the fill rule to make a good choice: a 3:2 landscape is
 * either one per row at ~260px or two at ~129px, and the row height cannot land
 * between. Two per row of whatever shape reads best there — a landscape pair is short,
 * a portrait pair tall — and a lone item at the end of a day keeps the whole row.
 */
export function defaultItemsPerRow(containerWidth: number): number | undefined {
  return containerWidth < 640 ? 2 : undefined;
}

/**
 * Display aspect ratio (width / height) of a media item — the shape, not the raster.
 *
 * `width`/`height` on a file node are the **stored raster**; `angle` is the rotation the
 * display frame applies, so 90/270 swap the axes; and `sar` is the shape of one of that
 * raster's pixels, which is not 1 for an anamorphic video. An AVCHD `.MTS` stores 1440x1080
 * with `sar` 4/3 and *is* 16:9, so a layout that ignored the ratio would paint a whole album
 * at 4:3 and then jump when the first frame decoded and measured itself.
 *
 * `undefined` when the file has no stored dimensions. A missing `sar` means square pixels,
 * which is every still and most video.
 */
export function displayAspect(
  item: { width?: number; height?: number; angle?: number; sar?: number },
): number | undefined {
  const dims = displayDims(item);
  return dims ? dims.width / dims.height : undefined;
}

/**
 * Display size in whole pixels of a media item — the picture a viewer sees, which is what a
 * `contain` rendition is resized from. Same inputs and caveats as `displayAspect`; the
 * rounding must match what `generate-derivatives` decides the renditions from.
 */
export function displayDims(
  item: { width?: number; height?: number; angle?: number; sar?: number },
): { width: number; height: number } | undefined {
  const { width, height, angle, sar } = item;
  if (!width || !height || width <= 0 || height <= 0) return undefined;
  const ratio = sar && sar > 0 && Number.isFinite(sar) ? sar : 1;
  const squared = ratio >= 1 ? { width: Math.round(width * ratio), height } : { width, height: Math.round(height / ratio) };
  const a = ((angle ?? 0) % 360 + 360) % 360;
  return a === 90 || a === 270 ? { width: squared.height, height: squared.width } : squared;
}

/**
 * Lay `aspects` out as justified rows.
 *
 * The greedy pass adds items while the resulting row height stays above the target;
 * the item that would push it below closes the row, and is kept only when doing so
 * lands the row closer to the target than leaving it out.
 */
export function justifiedLayout(
  aspects: readonly number[],
  opts: JustifiedOptions,
): JustifiedLayout {
  const width = Math.floor(opts.containerWidth);
  const target = opts.targetRowHeight;

  // `Number.isFinite` and not just `<= 0`: a NaN width (an unmeasured container) passes
  // every comparison and would produce a grid of NaN geometry.
  if (!Number.isFinite(width) || !Number.isFinite(target) || width <= 0 || target <= 0 || aspects.length === 0) {
    return EMPTY;
  }

  const gap = Math.max(0, opts.gap);
  const perRow = opts.itemsPerRow !== undefined && opts.itemsPerRow >= 1 ? Math.floor(opts.itemsPerRow) : undefined;
  const minAspect = opts.minAspect ?? MIN_ASPECT;
  const maxAspect = opts.maxAspect ?? MAX_ASPECT;
  const minRowHeight = opts.minRowHeight ?? target * 0.65;
  const maxRowHeight = opts.maxRowHeight ?? target * 1.6;

  // A single extreme panorama would otherwise own a whole row at 90px tall. The tile
  // renders `object-fit: cover`, so a clamped item is centre-cropped in the grid and
  // still uncropped in the lightbox; everything inside the range is untouched.
  const safe = aspects.map((a) => (Number.isFinite(a) && a > 0 ? clamp(a, minAspect, maxAspect) : DEFAULT_ASPECT));

  // Gaps come out of the width, so only the pixels left over are shared by aspect.
  const rowHeight = (count: number, sumAspect: number) => (width - gap * (count - 1)) / sumAspect;

  const tiles: JustifiedTile[] = [];
  const rows: JustifiedRow[] = [];
  let y = 0;
  let i = 0;

  while (i < safe.length) {
    const firstIndex = i;
    let sum = 0;
    let count = 0;
    let height = Infinity;

    if (perRow !== undefined) {
      // Fixed columns: take the next `perRow` items and scale them to the width, the
      // last row too. No target, no floor, no ceiling — the shapes decide the height.
      while (i < safe.length && count < perRow) {
        sum += safe[i];
        count++;
        i++;
      }
      height = rowHeight(count, sum);
    } else {
      while (i < safe.length) {
        const trySum = sum + safe[i];
        const tryHeight = rowHeight(count + 1, trySum);

        if (count > 0 && tryHeight < target) {
          // This item overflows the row. Keep it only if the row ends up closer to the
          // target height with it than without it.
          if (target - tryHeight < height - target) {
            sum = trySum;
            count++;
            height = tryHeight;
            i++;
          }
          break;
        }

        sum = trySum;
        count++;
        height = tryHeight;
        i++;

        // One item already fills the width: the row is done either way.
        if (height <= target) break;
      }
    }

    // A last row that never filled usually keeps the target height and a ragged right
    // edge. Once it already occupies more than 80% at that height, the small remainder
    // reads as a mistake, so scale it the rest of the way. This is intentionally the
    // same rule at every viewport width.
    const ragged = perRow === undefined && i >= safe.length && height > target;
    let finalHeight: number;
    if (perRow !== undefined) {
      finalHeight = height;
    } else if (ragged) {
      const occupiedAtTarget = target * sum + gap * (count - 1);
      finalHeight = occupiedAtTarget / width > LAST_ROW_FILL_THRESHOLD ? height : target;
    } else {
      finalHeight = clamp(height, minRowHeight, maxRowHeight);
      // Honouring the floor would make the row wider than the container: fit instead.
      if (finalHeight > height && finalHeight * sum + gap * (count - 1) > width) {
        finalHeight = height;
      }
    }

    // Round on the accumulated edge, not per tile: widths sum to exactly the available
    // pixels, so the last tile in a justified row lands on `width` with no sliver and
    // no drift down the row.
    let x = 0;
    for (let n = 0; n < count; n++) {
      const index = firstIndex + n;
      const tileWidth = safe[index] * finalHeight;
      const left = Math.round(x);
      tiles.push({
        index,
        row: rows.length,
        left,
        top: Math.round(y),
        width: Math.round(x + tileWidth) - left,
        height: Math.round(finalHeight),
      });
      x += tileWidth + gap;
    }

    rows.push({ top: Math.round(y), height: Math.round(finalHeight), firstIndex, count });
    y += finalHeight + gap;
  }

  const lastRow = rows[rows.length - 1];

  return { tiles, rows, height: lastRow.top + lastRow.height };
}

/** The side of a square tile three to a phone's row, about; fewer per row scale it up, more down. */
const SQUARE_SIDE_AT_THREE = 180;

/**
 * How many square tiles a row of `containerWidth` holds when a phone shows
 * `phoneColumns`: that many at least, and more as the width allows, so a desktop's
 * squares stay about the size of a phone's rather than growing to fill a third of the
 * screen.
 */
export function squareColumns(containerWidth: number, phoneColumns: number): number {
  const side = SQUARE_SIDE_AT_THREE * 3 / phoneColumns;
  return Math.max(phoneColumns, Math.round(containerWidth / side));
}

/**
 * `count` square tiles in `columns` fixed columns, cropped by the tile as any other —
 * an overview, where the shapes are not the point. Unlike `itemsPerRow`, a short last
 * row keeps the same squares rather than stretching to the width. The same shape of
 * answer as `justifiedLayout`, so windowing and everything else read it alike.
 */
export function squareLayout(count: number, opts: { containerWidth: number; columns: number; gap: number }): JustifiedLayout {
  const width = Math.floor(opts.containerWidth);
  const columns = Math.max(1, Math.floor(opts.columns));
  if (!Number.isFinite(width) || width <= 0 || count <= 0) return EMPTY;

  const gap = Math.max(0, opts.gap);
  const side = (width - gap * (columns - 1)) / columns;
  const tiles: JustifiedTile[] = [];
  const rows: JustifiedRow[] = [];

  for (let firstIndex = 0; firstIndex < count; firstIndex += columns) {
    const row = rows.length;
    const top = Math.round(row * (side + gap));
    const height = Math.round((row + 1) * (side + gap) - gap) - top;
    const inRow = Math.min(columns, count - firstIndex);
    for (let column = 0; column < inRow; column++) {
      // Rounded on the accumulated edge, as in `justifiedLayout`: a full row ends exactly at `width`.
      const left = Math.round(column * (side + gap));
      tiles.push({ index: firstIndex + column, row, left, top, width: Math.round(column * (side + gap) + side) - left, height });
    }
    rows.push({ top, height, firstIndex, count: inRow });
  }

  const lastRow = rows[rows.length - 1];
  return { tiles, rows, height: lastRow.top + lastRow.height };
}

/** A strip tile's horizontal stretch over its natural width at the row height: past these it is cropped too much. */
const STRIP_MIN_FACTOR = 0.75;
const STRIP_MAX_FACTOR = 1.35;
/** A row is filled while its pictures at their natural width take no more than this share of it. */
const STRIP_OVERFILL = 1.15;
/** The aspect a strip assumes per picture when choosing how many to sample. */
const STRIP_SAMPLE_ASPECT = 1.2;
/** A strip tile is never narrower than 1:2 or wider than 5:2; a panorama is cropped to that. */
const STRIP_MIN_ASPECT = 0.5;
const STRIP_MAX_ASPECT = 2.5;
/** Sample counts a strip tries before it settles on the best it has seen. */
const STRIP_PASSES = 8;

type StripOptions = {
  containerWidth: number;
  rowHeight: number;
  /** How many rows the strip has; it is always this tall, however few pictures fill it. */
  rows: number;
  gap: number;
};

type StripLayout = {
  /** The pictures shown, `index` into the input, in order. */
  tiles: JustifiedTile[];
  /** `rows` rows and the gaps between them, whatever the strip holds. */
  height: number;
};

/** `k` indexes spread evenly over `count`, the first always among them. */
export function stripSample(count: number, k: number): number[] {
  const take = Math.max(0, Math.min(count, Math.floor(k)));
  return Array.from({ length: take }, (_, n) => Math.floor((n * count) / take));
}

type StripRow = { indexes: number[]; natural: number; factor: number };

/** Fill `rows` rows from `sample` (indexes into `aspects`); what does not fit is left over. */
function fillStrip(aspects: readonly number[], sample: number[], width: number, height: number, rows: number, gap: number) {
  const natural = (index: number) => clamp(aspects[index], STRIP_MIN_ASPECT, STRIP_MAX_ASPECT) * height;
  const room = (count: number) => width - gap * (count - 1);
  const placed: StripRow[] = [];
  let row: StripRow = { indexes: [], natural: 0, factor: 1 };
  let next = 0;
  const close = () => {
    row.factor = room(row.indexes.length) / row.natural;
    placed.push(row);
    row = { indexes: [], natural: 0, factor: 1 };
  };
  while (next < sample.length && placed.length < rows) {
    const index = sample[next];
    const w = natural(index);
    const count = row.indexes.length + 1;
    if (row.indexes.length === 0 || row.natural + w <= STRIP_OVERFILL * room(count)) {
      row.indexes.push(index);
      row.natural += w;
      next++;
      continue;
    }
    // The picture overflows the row. It joins it anyway when the row would otherwise be
    // stretched past the clamp and taking it squeezes the row by no more than the clamp allows;
    // otherwise it starts the next row.
    const without = room(row.indexes.length) / row.natural;
    const withIt = room(count) / (row.natural + w);
    if (without > STRIP_MAX_FACTOR && withIt >= STRIP_MIN_FACTOR) {
      row.indexes.push(index);
      row.natural += w;
      next++;
    }
    close();
  }
  if (row.indexes.length > 0 && placed.length < rows) close();
  return { placed, leftover: sample.length - next };
}

/**
 * Two rows (or `rows`) of a group's pictures at one height, filled to the width: a closed
 * section's preview. `k` pictures are sampled evenly in order, and `k` is searched for, starting
 * from as many as the rows hold at an average shape, until the sample fills the rows with none
 * left over (or, failing that, fills them with the fewest left over). Each row is filled while its
 * pictures at their natural width take no more than 115% of it, then scaled to the exact
 * width. A row that would be stretched past 135% or squeezed past 75% takes or leaves its last
 * picture to stay inside that; the pictures are drawn `cover`, so the stretch is a crop. The last
 * row of a strip with too few pictures to fill it keeps their natural widths. The strip is always
 * `rows` rows tall, so every closed section is the same height.
 */
export function stripLayout(aspects: readonly number[], opts: StripOptions): StripLayout {
  const width = Math.floor(opts.containerWidth);
  const height = opts.rowHeight;
  const rows = Math.max(1, Math.floor(opts.rows));
  const gap = Math.max(0, opts.gap);
  const stripHeight = rows * height + (rows - 1) * gap;
  if (!Number.isFinite(width) || width <= 0 || !(height > 0) || aspects.length === 0) return { tiles: [], height: stripHeight };

  const safe = aspects.map((a) => (Number.isFinite(a) && a > 0 ? a : DEFAULT_ASPECT));
  const tryCount = (k: number) => {
    const result = fillStrip(safe, stripSample(safe.length, k), width, height, rows, gap);
    const last = result.placed[result.placed.length - 1];
    const full = result.placed.length === rows && last !== undefined && last.factor <= STRIP_MAX_FACTOR;
    return { ...result, k, full };
  };
  // Better: rows filled, then nothing left over, then more pictures.
  const better = (a: ReturnType<typeof tryCount>, b: ReturnType<typeof tryCount>) =>
    a.full !== b.full ? a.full : (a.leftover === 0) !== (b.leftover === 0) ? a.leftover === 0 : a.leftover !== b.leftover ? a.leftover < b.leftover : a.k > b.k;

  // A bisection between too few (rows left short) and too many (pictures left over), from as
  // many as the rows hold at an average shape.
  let low = 1;
  let high = safe.length;
  let k = Math.min(safe.length, Math.ceil((rows * width) / (STRIP_SAMPLE_ASPECT * height)));
  let fill = tryCount(k);
  for (let pass = 1; pass < STRIP_PASSES; pass++) {
    const tried = pass === 1 ? fill : tryCount(k);
    if (better(tried, fill)) fill = tried;
    if (tried.leftover > 0) high = k - 1;
    else if (!tried.full) low = k + 1;
    else break;
    if (low > high) break;
    k = tried.leftover > 0 ? Math.max(low, Math.min(high, k - tried.leftover)) : Math.min(high, Math.max(low, Math.round((low + high) / 2)));
  }

  const tiles: JustifiedTile[] = [];
  fill.placed.forEach((row, rowIndex) => {
    const isLast = rowIndex === fill.placed.length - 1;
    // A last row too sparse to justify keeps the pictures' own widths.
    const factor = isLast && row.factor > STRIP_MAX_FACTOR ? 1 : row.factor;
    const top = Math.round(rowIndex * (height + gap));
    let x = 0;
    for (const index of row.indexes) {
      const tileWidth = clamp(safe[index], STRIP_MIN_ASPECT, STRIP_MAX_ASPECT) * height * factor;
      const left = Math.round(x);
      tiles.push({ index, row: rowIndex, left, top, width: Math.round(x + tileWidth) - left, height: Math.round(height) });
      x += tileWidth + gap;
    }
  });
  return { tiles, height: stripHeight };
}
