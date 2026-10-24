/**
 * What the system commands share: the windows and the reader for `metrics-sampler`'s series, and
 * the formatting of their text output.
 *
 * Nothing here probes the host. Every resource number is read back from the series the sampler
 * writes, so the cost of a second browser is a few indexed range scans rather than another
 * `nvidia-smi`. That also makes the charts survive a page reload — a client-side ring buffer
 * would start empty every time.
 *
 * Rates are derived, never stored; a counter that went backwards yields no rate at all.
 */

import { downsample, readTail, type Sample, seriesPath } from '../../../../lib/metrics/mod.ts';
import type { MetricPoint, ShellOrigin } from '../../../../lib/api/system.ts';
import { textWidth } from '../../../shell/terminal/width.ts';
import type { Command } from '../../command.ts';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Throughput is a *current* rate — an hour of history, not a lifetime average. */
export const RATE_WINDOW_MS = HOUR;

/** Points per chart. More than this is thinner than a pixel on any real layout. */
export const POINTS = 120;

export const toPoints = <T>(samples: Sample<T>[], value: (entry: T) => number | undefined): MetricPoint[] => {
  const points: MetricPoint[] = [];
  for (const sample of downsample(samples, POINTS)) {
    const v = value(sample.value);
    if (v !== undefined) points.push({ at: sample.at, value: v });
  }
  return points;
};

export const latest = <T>(samples: Sample<T>[]): T | undefined => samples[samples.length - 1]?.value;

/**
 * Read the last `limit` samples of one series.
 *
 * Each caller's limit is the window its figure needs, at that series' cadence (see
 * METRICS_SERIES) — the log API pages by cursor, so the row count *is* the time span. Sized
 * generously enough to survive a sampler restart that wrote a denser stretch, and small enough
 * that a 10s poll stays cheap.
 */
export const readSeries = <T>(cmd: Command, name: Parameters<typeof seriesPath>[0], limit: number): Promise<Sample<T>[]> =>
  readTail<T>(cmd.sys.vfs, cmd.access, seriesPath(name), limit);

export const fmtPct = (value: number | undefined): string => value === undefined ? '  ? ' : `${value.toFixed(0).padStart(3)}%`;

export const fmtBytes = (bytes: number | undefined): string => {
  if (bytes === undefined) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};

export const fmtEta = (ms: number | undefined): string => {
  if (ms === undefined) return '';
  const hours = ms / HOUR;
  if (hours < 1) return `  eta ${Math.round(ms / MINUTE)}m`;
  if (hours < 48) return `  eta ${hours.toFixed(1)}h`;
  return `  eta ${(hours / 24).toFixed(1)}d`;
};

/** `42s`, `4m03s`, `3h12m`, `4d03h`: how long, in the two units that matter at that length. */
export const fmtAge = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`;
};

/**
 * A shell as `ps` and `who` name it: a service's shell by the service, any other by where its
 * input comes from and the end of its name (`ssh/7KQ2`), which tells two sessions of one person
 * apart.
 */
export const fmtTty = (tty: string, origin: ShellOrigin, service?: string): string => origin === 'service' && service ? service : `${origin}/${tty.slice(-4)}`;

/**
 * The columns a table's last column has on the caller's terminal once the `columns` before it take
 * their widest, so that a long command line stops at the edge as procps's `ps` stops it. Through a
 * pipe there is no edge, and a line is whole.
 */
export const lastColumnRoom = (cmd: Command, rows: Record<string, string>[], columns: string[]): number => {
  if (!cmd.tty) return Infinity;
  const used = columns.reduce((sum, key) => sum + Math.max(textWidth(key), ...rows.map((row) => textWidth(row[key]))) + 1, 0);
  return Math.max(8, cmd.cols - used);
};
