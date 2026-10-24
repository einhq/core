/**
 * Event-loop lag — how long a ready callback waits before it runs.
 *
 * The one number that distinguishes the two ways this process gets slow, which
 * look identical from the outside. CPU exhaustion shows up in `cpu.stat`; being
 * *scheduled* late — a continuation queued behind a flood of pending macrotasks,
 * or behind an oversubscribed host run queue — does not, while a core is far
 * from saturated. Utilization cannot tell those apart. Lag can.
 *
 * A timer that asks to fire every PROBE_MS and reports how late it actually was
 * measures exactly what a WebSocket read or an SSH keystroke experiences, since
 * they wait in the same queue.
 *
 * The probe is unref'd, so it never holds the runtime open, and it accumulates
 * into a window that the sampler drains. Draining rather than snapshotting is
 * deliberate: a max that is never reset reports the worst moment since boot
 * forever, which stops being news after the first spike.
 */

import type { PriorityPoolStats } from '../pg/mod.ts';

/** How often the probe asks to be woken. Fine enough to catch a stall, cheap enough to leave on. */
const PROBE_MS = 100;

/**
 * Cap on retained observations per window. At PROBE_MS this is ~100s of ticks,
 * comfortably more than the 15s sampler cadence; the bound only matters if the
 * sampler stops draining, and then it is what stops a leak.
 */
const MAX_OBSERVATIONS = 1024;

type LoopLagSample = {
  /** Worst delay past the scheduled wake-up in the window, milliseconds. */
  maxMs: number;
  /** Mean delay over the window. */
  meanMs: number;
  /** 99th percentile delay — what a user actually notices, without the single outlier. */
  p99Ms: number;
  /** Probe ticks observed. Well below window/PROBE_MS means the probe itself was starved. */
  samples: number;
};

/**
 * Counters for the router relay path.
 *
 * `published` is every event fanned out; `queried` is how many of those reached
 * postgres. Every VFS mutation publishes, so the gap between the two is the
 * whole point of the bound-routing-key cache — a `queried` that tracks
 * `published` means the cache is not working.
 */
type RelayCounters = {
  published: number;
  queried: number;
};

export type RuntimeSample = {
  lag: LoopLagSample;
  relay?: RelayCounters;
  pool?: PriorityPoolStats;
};

let observations: number[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
let previous = 0;

const tick = (): void => {
  const now = performance.now();
  // Negative is impossible in principle and would only come from clock skew;
  // clamped so it cannot drag the mean below the truth.
  const lag = Math.max(0, now - previous - PROBE_MS);
  previous = now;

  if (observations.length < MAX_OBSERVATIONS) {
    observations.push(lag);
  }
};

/**
 * Begin observing. Idempotent — the sampler calls it on every tick rather than
 * arranging for boot to know about it, and a second call is a no-op.
 */
export const startLoopLagProbe = (): void => {
  if (timer !== undefined) return;

  previous = performance.now();
  const handle = setInterval(tick, PROBE_MS);
  timer = handle;

  // Never a reason to keep the process alive for a measurement.
  try {
    Deno.unrefTimer(handle);
  } catch {
    // Not Deno, or the API moved. The probe still works; it just counts as work.
  }
};

export const stopLoopLagProbe = (): void => {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
  observations = [];
};

/**
 * Relay counters, incremented by the registry relay consumers.
 *
 * Free-standing counters rather than a value read off a registry: there is one
 * relay path but several registries on it, they are constructed per mount, and
 * none of them is reachable from here. Both are cumulative and never reset, so
 * the sampler differences them the same way it differences `cpu.usageUsec`.
 */
let published = 0;
let queried = 0;

/**
 * @param hitPostgres Whether this event got past the bound-routing-key check.
 *                    `queried` tracking `published` means the cache is not working.
 */
export const countRelayEvent = (hitPostgres: boolean): void => {
  published++;
  if (hitPostgres) queried++;
};

const relayCounters = (): RelayCounters => ({ published, queried });

/**
 * The postgres pool, once something owns one.
 *
 * Registered rather than imported because the pool is built in
 * `primary-main.ts` and is not reachable from here — the same reason the relay
 * counters above are free-standing. A process without one (a test, an
 * in-memory mount) simply reports no `pool` key.
 *
 * This is the series that says whether the interactive reservation is doing
 * anything: `backgroundGated` above zero with `idle` above zero means
 * background work is being held back so a shell does not have to wait, which is
 * the trade being made on purpose. `backgroundTimeouts` above zero means the
 * safety valve fired and wants reading about.
 */
let poolStats: (() => PriorityPoolStats) | undefined;

export const registerPoolStats = (source: () => PriorityPoolStats): void => {
  poolStats = source;
};

/**
 * Drain the window into a sample. Returns `undefined` before the probe has seen
 * anything, so the sampler writes no row rather than a run of zeroes that would
 * read as "the loop was perfectly responsive".
 */
export const sampleRuntime = (): RuntimeSample | undefined => {
  startLoopLagProbe();

  const window = observations;
  observations = [];

  if (window.length === 0) return undefined;

  const sorted = [...window].sort((a, b) => a - b);
  const total = window.reduce((sum, value) => sum + value, 0);
  // Index, not interpolation: with ~150 observations the difference is noise,
  // and this cannot land past the end of the array.
  const p99Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));

  return {
    lag: {
      maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
      meanMs: Math.round((total / window.length) * 100) / 100,
      p99Ms: Math.round(sorted[p99Index] * 100) / 100,
      samples: window.length,
    },
    relay: relayCounters(),
    pool: poolStats?.(),
  };
};
