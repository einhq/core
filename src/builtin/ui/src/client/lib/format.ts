/** Shared value formatting for media UI. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Bytes at human scale — 1.4 GB, 812 MB, 0 B. */
export function formatBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes === 0) return '0 B';

  const exponent = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  // One decimal below 100 keeps "1.4 GB" informative without "1.437 GB" noise.
  return `${value.toFixed(exponent === 0 || Math.abs(value) >= 100 ? 0 : 1)} ${UNITS[exponent]}`;
}

/**
 * A duration as the largest unit that still says something useful.
 *
 * Deliberately coarse: these are estimates derived from a throughput average,
 * and "2.3 d" claims exactly as much precision as the input supports, where
 * "2 d 7 h 12 m" would claim far more.
 */
export function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';

  const minutes = ms / 60_000;
  if (minutes < 1) return '<1 min';
  if (minutes < 90) return `${Math.round(minutes)} min`;

  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} h`;

  const days = hours / 24;
  if (days < 90) return `${days.toFixed(1)} d`;

  return `${(days / 30.44).toFixed(1)} months`;
}

/**
 * A playback position or media length as a clock — 0:07, 30:57, 1:04:12.
 *
 * Distinct from `formatDuration` above, which is deliberately coarse because it formats
 * *estimates*. This one is exact: it labels a real position in a real file, so seconds
 * matter and rounding them away would make a scrubber look broken.
 *
 * Empty string for "no such value" (undefined, NaN, negative) so a caller can render it
 * conditionally — but 0 is a real position and formats as 0:00.
 */
export function formatClock(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '';

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Compact counts for tiles — 12.4k, 175k, 942. */
export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 100_000) return `${(value / 1000).toFixed(0)}k`;
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return value.toLocaleString();
}

/** Uptime, at the granularity anyone actually reads it. */
export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * One date at the precision it was recorded with: `1966` stays "1966" and
 * `1966-04` "Apr 1966", rather than both becoming "1 Jan 1966" — a day nobody
 * wrote down, and which reads as a birthday.
 */
const formatDate = (iso: string): string => {
  if (/^\d{4}$/.test(iso)) return iso;
  const monthOnly = /^\d{4}-\d{2}$/.test(iso);
  const opts: Intl.DateTimeFormatOptions = monthOnly
    ? { month: 'short', year: 'numeric', timeZone: 'UTC' }
    : { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };
  const date = new Date(monthOnly ? `${iso}-01` : iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('en-GB', opts);
};

/** Compact human date range, e.g. "1 Jun 2026", "1 Jun 2026 – 3 Jun 2026" or "1966 – 1968". */
export function formatRange(startIso?: string, endIso?: string): string {
  if (!startIso) return '';
  const sf = formatDate(startIso);
  const ef = endIso ? formatDate(endIso) : sf;
  return sf === ef ? sf : `${sf} – ${ef}`;
}
