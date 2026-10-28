/**
 * Turning stored readings into the numbers a dashboard shows.
 *
 * One rule underlies all of it: the sampler stores counters, the reader derives
 * rates. That is what lets the sampler restart without losing a series and what
 * makes every rate on the page — CPU %, pool throughput, crawl throughput, disk
 * growth — the same arithmetic instead of four bespoke ones.
 */

import type { HostCpuTicks } from './host.ts';
import type { Sample } from './types.ts';

/**
 * Default floor for a throughput rate.
 *
 * Job counters tick in whole units, so a short window quantizes badly: one job
 * finishing in a 15s window reads as 240/hour, none as zero, and neither is the
 * truth. A minute of span smooths that out.
 *
 * Utilization is the opposite case and passes its own floor — `usage_usec` has
 * microsecond resolution, so a 15s window holds 15 million counts and the
 * quantization argument simply does not apply. Holding CPU to the throughput
 * floor would make it unreportable: consecutive samples are 15s apart, so the
 * "current" reading would never have a wide enough pair to measure.
 */
const MIN_SPAN_MS = 60_000;

/** Floor for a high-resolution gauge like CPU time — one sampling interval. */
const GAUGE_MIN_SPAN_MS = 10_000;

/**
 * Rate of change per millisecond, from the widest pair of samples available.
 *
 * The endpoints rather than a regression, because these counters are monotone
 * and evenly spaced — a least-squares fit over the same points lands in the
 * same location and hides which two observations produced it.
 *
 * Endpoints alone are not enough to be safe, though. These counters do reset:
 * `pool.counts.done` drops when `pool retry` sends finished jobs back, and a
 * restarted host zeroes `cpu.usage_usec`. A reset on the *last* sample is obvious — the delta
 * goes negative — but a reset in the middle of the window is not: 0 → 900 → 5
 * still ends higher than it started, and reporting 5 units of progress over an
 * hour would put a wildly optimistic ETA on the page. So the series is scanned
 * for the last decrease and only the samples after it are used; if that leaves
 * too little to measure, there is no rate rather than a wrong one.
 */
export const rate = <T>(
  samples: Sample<T>[],
  value: (entry: T) => number | undefined,
  minSpanMs: number = MIN_SPAN_MS,
): number | undefined => {
  const readings = samples
    .map((sample) => ({ at: sample.at, value: value(sample.value) }))
    .filter((reading): reading is { at: number; value: number } => reading.value !== undefined);

  if (readings.length < 2) return undefined;

  let start = 0;
  for (let i = 1; i < readings.length; i++) {
    if (readings[i].value < readings[i - 1].value) start = i;
  }

  const first = readings[start];
  const last = readings[readings.length - 1];
  if (first === last) return undefined;

  const span = last.at - first.at;
  if (span < minSpanMs) return undefined;

  return (last.value - first.value) / span;
};

/**
 * This cgroup's CPU utilization as a percentage of all cores, from the cumulative microsecond counter. A caller
 * that reads the counter more often than the sampler does passes a shorter floor.
 */
export const cpuPercent = (samples: Sample<{ usageUsec: number; cores: number }>[], minSpanMs: number = GAUGE_MIN_SPAN_MS): number | undefined => {
  const perMs = rate(samples, (entry) => entry.usageUsec, minSpanMs);
  if (perMs === undefined) return undefined;

  const cores = samples[samples.length - 1].value.cores || 1;
  // usage is in microseconds, the span in milliseconds: 1000 µs of CPU per ms
  // of wall clock is one core saturated.
  return clampPercent((perMs / 1000 / cores) * 100);
};

/**
 * The machine's CPU utilization over the span of the samples, as busy ticks over all ticks of
 * `/proc/stat`; undefined unless the first and last both carry the host's counters.
 */
export const hostCpuPercent = (samples: Sample<{ host?: HostCpuTicks }>[]): number | undefined => {
  if (samples.length < 2) return undefined;
  const first = samples[0].value.host;
  const last = samples[samples.length - 1].value.host;
  if (!first || !last) return undefined;
  const total = last.total - first.total;
  // No ticks between them, or the counters started over with a reboot.
  if (total <= 0 || last.busy < first.busy) return undefined;
  return clampPercent(((last.busy - first.busy) / total) * 100);
};

export const percent = (used: number, total: number | undefined): number | undefined => total === undefined || total <= 0 ? undefined : clampPercent((used / total) * 100);

const clampPercent = (value: number): number => Math.max(0, Math.min(100, Math.round(value * 10) / 10));

/**
 * How long `remaining` units take at `perMs`, or undefined when the answer
 * would be a fiction — nothing left to do, or nothing being done.
 */
export const eta = (remaining: number, perMs: number | undefined): number | undefined => {
  if (remaining <= 0 || perMs === undefined || perMs <= 0) return undefined;
  return Math.round(remaining / perMs);
};

/**
 * Thin a series to at most `points` evenly spaced samples, newest always kept.
 *
 * Picking every Nth sample rather than averaging buckets: these are gauges, and
 * a mean would flatten exactly the spikes worth seeing on a utilization chart.
 */
export const downsample = <T>(samples: Sample<T>[], points: number): Sample<T>[] => {
  if (samples.length <= points || points < 1) return samples;

  const step = samples.length / points;
  const out: Sample<T>[] = [];
  for (let i = 0; i < points; i++) out.push(samples[Math.floor(i * step)]);

  const newest = samples[samples.length - 1];
  if (out[out.length - 1] !== newest) out[out.length - 1] = newest;
  return out;
};

/** Samples no older than `windowMs`. */
export const within = <T>(samples: Sample<T>[], windowMs: number): Sample<T>[] => {
  const since = Date.now() - windowMs;
  return samples.filter((sample) => sample.at >= since);
};
