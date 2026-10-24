/**
 * Date buckets and their labels — what a timeline's headers say, and what a
 * scrubber's tooltip says.
 *
 * A bucket key is a truncated ISO date: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, and
 * the empty string for media that carries no date at all. Keeping the labels
 * here rather than beside each feed is what lets the map's cluster grid, the
 * subject timelines and the global timeline agree on how June 1998 is written.
 */

export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `1998-06` -> "June 1998"; a bare year stays as it is. */
export const monthLabel = (key: string): string => {
  const [year, month] = key.split('-');
  if (!month) return year;
  return `${MONTHS[Number(month) - 1] ?? month} ${year}`;
};

/**
 * `YYYY-MM` -> "June 1998", `YYYY-MM-DD` -> "12 June 1998"; a bare year stays
 * as it is; undated gets its own bucket.
 */
export const bucketLabel = (key: string): string => {
  if (key === '') return 'Undated';
  const [year, month, day] = key.split('-');
  if (!month) return year;
  const monthName = MONTHS[Number(month) - 1] ?? month;
  return day ? `${Number(day)} ${monthName} ${year}` : `${monthName} ${year}`;
};

/**
 * How wide a bucket is.
 *
 * `none` puts everything in one bucket, which is not the same as not bucketing:
 * a seam still splits it. A prepended page must never be packed into the grid
 * that was already on screen, or every row below it moves — so an unheaded list
 * is one bucket per segment, not one grid.
 */
export type DateGranularity = 'day' | 'month' | 'year' | 'none';

const KEY_LENGTH: Record<DateGranularity, number> = { year: 4, month: 7, day: 10, none: 0 };

/** The bucket an ISO date falls in; undated is the empty key. */
export const bucketKey = (takenAt: string | undefined, granularity: DateGranularity): string =>
  granularity === 'none' ? 'all' : takenAt ? takenAt.slice(0, KEY_LENGTH[granularity]) : '';

export type DateBucket<T> = {
  /** `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or the empty string for undated. */
  key: string;
  label: string;
  items: T[];
  /** Where this bucket starts in the flat list, so a grid can map a tile back to it. */
  startIndex: number;
  /** A continuation of the bucket above it, split at a seam rather than by date. */
  continued?: boolean;
};

export type BucketOptions<T> = {
  /**
   * Force a new bucket at this item even when the date has not changed.
   *
   * For a list that grows at the top: a justified grid packs its rows greedily
   * from the front, so inserting pictures into the *start* of an existing bucket
   * re-packs every row after them and moves everything below, on screen, while
   * the reader is scrolling. Cutting the bucket at the seam leaves every existing row exactly as it was; the cost is one ragged row
   * in the middle of a month, which is what the bucket boundaries already look
   * like.
   */
  startsSegment?: (item: T) => boolean;
};

/**
 * Consecutive runs of a time-ordered list, split where the bucket changes.
 *
 * Runs, not a grouping: the callers all feed it an answer that is already
 * ordered by date, so a bucket is a slice of the list and `startIndex` is a
 * real offset into it — which is what a grid needs to map a tile back to the
 * flat list the lightbox walks.
 */
export function bucketByDate<T>(
  items: T[],
  dateOf: (item: T) => string | undefined,
  granularity: DateGranularity,
  options: BucketOptions<T> = {},
): DateBucket<T>[] {
  const buckets: DateBucket<T>[] = [];
  let current: DateBucket<T> | undefined;

  items.forEach((item, index) => {
    const key = bucketKey(dateOf(item), granularity);
    const seam = index > 0 && options.startsSegment?.(item) === true;
    if (!current || current.key !== key || seam) {
      const continued = current !== undefined && current.key === key;
      current = { key, label: bucketLabel(key), items: [], startIndex: index, ...(continued ? { continued } : {}) };
      buckets.push(current);
    }
    current.items.push(item);
  });

  return buckets;
}
