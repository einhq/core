/**
 * The capture-time vocabulary: what a capture time looks like, how precise it is, and what
 * instant it names.
 *
 * A capture time is **one string whose precision is its own length**. `1975` is a year and
 * claims nothing more; `2003-04-30` is a day; `2015-07-25T14:03:11+02:00` is a second with the
 * offset the photographer was standing in. There is no stored `accuracy` field, because a
 * stored one goes stale the moment somebody edits the value and a derived one cannot.
 *
 * Two things come out of a capture time and they are not the same string:
 *
 * - the value itself, which is a **wall clock** and answers "what did the clock on the wall
 *   say" — what a year facet, a date range and a rendered caption all mean; and
 * - `toUtc()`, a complete UTC instant, which is what **sorts**. Ordering photographs by their
 *   wall clocks puts a Tokyo noon before a Stockholm breakfast that happened four hours
 *   earlier, and no amount of care elsewhere fixes that.
 *
 * Both are text, and both are compared as text: the store's comparisons are byte comparisons
 * (`vfs/query.ts`), and a complete fixed-width UTC string byte-sorts exactly as the epoch
 * integer would while staying legible in an `attrs` dump.
 */

/** How much of a capture time is real. Derived from its length, never stored. */
export type TimePrecision = 'year' | 'month' | 'day' | 'minute' | 'second';

/**
 * `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`, `YYYY-MM-DDTHH:MM:SS`, the last two
 * optionally carrying `Z` or `±HH:MM`.
 *
 * An offset below minute precision is not accepted: an offset says which clock the wall time
 * was read off, and a year has no clock.
 */
const CAPTURE_TIME = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[-+]\d{2}:\d{2})?)?)?)?$/;

/**
 * Earliest plausible capture date; the first surviving photograph is 1826.
 */
const MIN_YEAR = 1826;

/** Whether the components name a day that exists — catches 02-30 and month 00. */
const isRealDate = (year: number, month: number, day: number): boolean => {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
};

export type CaptureTimeParts = {
  year: string;
  month?: string;
  day?: string;
  hour?: string;
  minute?: string;
  second?: string;
  /** `Z` normalized to `+00:00`, so an offset is always comparable arithmetic. */
  offset?: string;
  precision: TimePrecision;
};

/**
 * Split a capture time into its parts, or undefined when the string is not one.
 *
 * Deliberately strict. The attr this parses is compared as bytes by every range query and
 * every index, so `12/25/2003` — which `Date.parse` accepts — is not a near miss to be
 * tolerated but a value that would sort among the year 12s forever.
 */
export const parseCaptureTime = (value: string, opts: { allowFuture?: boolean } = {}): CaptureTimeParts | undefined => {
  const match = CAPTURE_TIME.exec(value.trim());
  if (!match) return undefined;

  const [, year, month, day, hour, minute, second, zone] = match;

  const y = Number(year);
  // The future ceiling applies to *values* and not to *questions about them*: a camera cannot
  // have taken a photograph next decade, but `--at 2030` is a perfectly reasonable way to say
  // "start at the end", and the bound helpers below pass `allowFuture`.
  if (y < MIN_YEAR) return undefined;
  if (!opts.allowFuture && y > new Date().getUTCFullYear() + 1) return undefined;
  if (month !== undefined && (Number(month) < 1 || Number(month) > 12)) return undefined;
  if (day !== undefined && !isRealDate(y, Number(month), Number(day))) return undefined;
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59)) return undefined;
  // 60 is a leap second, which exiftool does emit and which Temporal folds into the next minute.
  if (second !== undefined && Number(second) > 60) return undefined;

  const precision: TimePrecision = second !== undefined ? 'second' : hour !== undefined ? 'minute' : day !== undefined ? 'day' : month !== undefined ? 'month' : 'year';

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    offset: zone === 'Z' ? '+00:00' : zone,
    precision,
  };
};

/** Whether a string is a capture time this system will store. */
export const isCaptureTime = (value: string): boolean => parseCaptureTime(value) !== undefined;

/** How much of a capture time is real, or undefined when it is not one. */
export const precisionOf = (value: string): TimePrecision | undefined => parseCaptureTime(value)?.precision;

/** The offset in seconds a capture time carries, or undefined when it names no clock. */
export const offsetOf = (value: string): number | undefined => {
  const offset = parseCaptureTime(value)?.offset;
  if (offset === undefined) return undefined;
  const sign = offset.startsWith('-') ? -1 : 1;
  const [hours, minutes] = offset.slice(1).split(':').map(Number);
  return sign * (hours * 3600 + minutes * 60);
};

/** A capture time with any offset removed — the bare wall clock. */
export const wallClockOf = (value: string): string => {
  const parts = parseCaptureTime(value);
  if (!parts?.offset) return value.trim();
  return value.trim().slice(0, -parts.offset.length);
};

/**
 * `+02:00` / `-05:30` for a number of seconds.
 *
 * ISO offsets have minute resolution, so a value that is not a whole number of minutes has to
 * lose something; it is rounded to the nearest minute rather than truncated. Real offsets are
 * always whole minutes, but a camera's clock error recorded as if it were a zone (`-7190`
 * seconds) need not be, and truncating it would be wrong by an extra minute for no reason.
 */
export const formatOffset = (offsetSeconds: number): string => {
  const sign = offsetSeconds < 0 ? '-' : '+';
  const total = Math.round(Math.abs(offsetSeconds) / 60) * 60;
  const hours = Math.floor(total / 3600);
  const minutes = (total % 3600) / 60;
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

/**
 * Stamp a wall clock with the offset it was read in.
 *
 * Only meaningful at minute precision or finer — a year has no clock to be offset from — so a
 * coarser value is returned untouched rather than gaining a suffix that claims more than it knows.
 */
export const withOffset = (value: string, offsetSeconds: number): string => {
  const parts = parseCaptureTime(value);
  if (!parts) return value;
  if (parts.precision !== 'minute' && parts.precision !== 'second') return wallClockOf(value);
  return `${wallClockOf(value)}${formatOffset(offsetSeconds)}`;
};

/** The start of the period a capture time names, as a complete `YYYY-MM-DDTHH:MM:SS`. */
const padToSecond = (parts: CaptureTimeParts): string =>
  `${parts.year}-${parts.month ?? '01'}-${parts.day ?? '01'}` +
  `T${parts.hour ?? '00'}:${parts.minute ?? '00'}:${parts.second ?? '00'}`;

/**
 * The UTC instant a capture time names, as `YYYY-MM-DDTHH:MM:SSZ`.
 *
 * A partial value names the **start** of its period, so `1975` is midnight on New Year's Day —
 * which is why a year-only time sorts an hour before its own displayed year in a positive
 * offset. That is the honest answer: the file is somewhere in 1975 and the earliest point it
 * could be is where it sorts.
 *
 * `zone` is only consulted when the value carries no offset of its own. It is an IANA id, and
 * `Temporal` resolves it against the *wall clock in question* rather than today's rules, so a
 * 1975 summer photograph gets 1975's summer-time offset and not this year's.
 */
export const toUtc = (value: string, zone: string, opts: { allowFuture?: boolean } = {}): string | undefined => {
  const parts = parseCaptureTime(value, opts);
  if (!parts) return undefined;

  const wall = padToSecond(parts);
  try {
    const instant = parts.offset === undefined ? Temporal.PlainDateTime.from(wall).toZonedDateTime(zone).toInstant() : Temporal.Instant.from(`${wall}${parts.offset}`);
    return instant.toString({ smallestUnit: 'second' });
  } catch {
    // An unknown IANA id, or a wall clock Temporal refuses. Neither is worth failing a whole
    // index pass over: the caller writes no timestamp and the file drops out of ordered
    // queries, which is what an undated file already does.
    return undefined;
  }
};

/**
 * Normalize a user-supplied bound to something comparable against a stored capture time.
 *
 * `1995` → `1995`, `1995-06` → `1995-06`; the prefix comparison does the rest, so no padding is
 * needed — but a full date still has to sort correctly against `YYYY-MM-DDTHH:MM:SS`, which it
 * does. Bounds are compared against the **wall clock** attr, never the UTC one: `--from 1995`
 * is a question about what the calendar said, not about an instant.
 */
export const lowerBound = (input: string): string | undefined => {
  const trimmed = input.trim();
  return parseCaptureTime(trimmed, { allowFuture: true }) ? wallClockOf(trimmed) : undefined;
};

/**
 * Exclusive upper bound for a possibly-partial date: `--to 2000` should include all of 2000, so
 * the bound becomes `2001`.
 *
 * Below month precision the bound is built by appending `~` rather than by adding one to the
 * last component. `~` (0x7E) sorts after every digit and after the `+`/`-`/`Z` of an offset, so
 * `2003-04-30T~` covers every time of day on the 30th *and* every zone it might be stamped
 * with — and there is no 59-rolls-to-60 arithmetic to get wrong.
 */
export const upperBoundExclusive = (input: string): string | undefined => {
  const bound = lowerBound(input);
  if (bound === undefined) return undefined;

  const precision = parseCaptureTime(bound, { allowFuture: true })?.precision;
  if (precision === 'year') return String(Number(bound) + 1).padStart(4, '0');
  if (precision === 'month') {
    const [year, month] = bound.split('-').map(Number);
    return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
  }
  if (precision === 'day') return `${bound}T~`;
  if (precision === 'minute') return `${bound}:~`;
  return `${bound}~`;
};

/**
 * The UTC instants a possibly-partial date spans: `[from, to)`.
 *
 * `--from`/`--to` filter on the wall clock, but `--at` is a *seek into the ordering*, and the
 * ordering is on `takenAtUtc`. A seek expressed in a different scale from the order it seeks
 * into makes the condition and the ORDER BY disagree, and paging then skips rows quietly. So
 * the user still types a wall clock and this turns it into the pair of instants that wall clock
 * spans, in the archive's own zone.
 *
 * The exclusive end is the *start of the next period*, computed with real calendar arithmetic
 * rather than by appending a sentinel: `2000-12` ends at `2001-01`, and `2000-02-28` at
 * `2000-02-29` because 2000 was a leap year.
 */
export const periodBoundsUtc = (input: string, zone: string): { from: string; to: string } | undefined => {
  const parts = parseCaptureTime(input.trim(), { allowFuture: true });
  if (!parts) return undefined;

  const from = toUtc(input.trim(), zone, { allowFuture: true });
  if (from === undefined) return undefined;

  const unit = { year: 'years', month: 'months', day: 'days', minute: 'minutes', second: 'seconds' } as const;
  try {
    const start = Temporal.PlainDateTime.from(padToSecond(parts));
    const next = start.add({ [unit[parts.precision]]: 1 });
    const to = parts.offset === undefined
      ? next.toZonedDateTime(zone).toInstant().toString({ smallestUnit: 'second' })
      : Temporal.Instant.from(`${next.toString({ smallestUnit: 'second' })}${parts.offset}`).toString({ smallestUnit: 'second' });
    return { from, to };
  } catch {
    return undefined;
  }
};
