/**
 * The metrics series — one log node each, and the single place they are named.
 *
 * A log per series rather than one fat entry per tick, because the three things
 * that differ between these measurements all live on the log node: retention
 * (a census of the tree is worth a year, CPU utilization is worth a week),
 * cadence (a 5-minute series should not be null-padded into a 15-second one),
 * and read cost (charting CPU should not deserialize disk and pool counters).
 * Adding a metric is a row here plus a probe, never a schema migration.
 *
 * Both the sampler and the reader import this table, so a path or a cadence is
 * never declared twice.
 */

import type { RetentionPolicy } from '../../registries/log/types.ts';

import { METRICS_PATH } from '../paths.ts';
export { METRICS_PATH };

export type MetricsSeriesName =
  | 'cpu'
  | 'memory'
  | 'runtime'
  | 'pools'
  | 'pipelines'
  | 'disk'
  | 'nodes';

export type MetricsSeries = {
  /** A core series (`MetricsSeriesName`). A module keeps its own series in its own service. */
  name: string;
  intervalMs: number;
  retention: RetentionPolicy;
  /** What the entry holds, for `ls`-level discoverability. */
  description: string;
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * Cadences are chosen against what the number can actually do in the interval:
 * CPU and VRAM swing within seconds, a pool drains over minutes, free disk and
 * the node census move over hours. Sampling faster than that buys noise and
 * rows.
 */
export const METRICS_SERIES: MetricsSeries[] = [
  { name: 'cpu', intervalMs: 15 * SECOND, retention: '7 day', description: "CPU time consumed, the machine's and this cgroup's" },
  { name: 'memory', intervalMs: 15 * SECOND, retention: '7 day', description: 'Resident memory against the cgroup cap' },
  // Lag is the counterpart to `cpu`, not a duplicate of it: utilization says
  // how much of a core we used, this says how long a ready callback waited. The
  // interesting state — busy but not saturated, yet everything feels slow — is
  // only visible in the second.
  { name: 'runtime', intervalMs: 15 * SECOND, retention: '7 day', description: 'Event-loop lag and router relay counters' },
  { name: 'pools', intervalMs: 15 * SECOND, retention: '7 day', description: 'Per-pool job counts by state' },
  { name: 'pipelines', intervalMs: MINUTE, retention: '30 day', description: 'Completed instances per pipeline' },
  // The slow pair is read by span, not by count: the log API pages by cursor,
  // so covering a week of disk trend means reading a week of rows on every
  // dashboard poll. At 15 minutes that is ~670 rows instead of ~2000, and free
  // space does not move fast enough for the resolution to be missed.
  { name: 'disk', intervalMs: 15 * MINUTE, retention: '90 day', description: 'Free and total bytes per storage tier' },
  { name: 'nodes', intervalMs: 15 * MINUTE, retention: '365 day', description: 'Node census by type' },
];

export const seriesPath = (name: string): string => `${METRICS_PATH}/${name}`;

/** The tick the sampler runs at — every cadence above is a multiple of it. */
export const TICK_MS = Math.min(...METRICS_SERIES.map((series) => series.intervalMs));
