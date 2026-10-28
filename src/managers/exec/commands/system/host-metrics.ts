/**
 * host-metrics — the machine's CPU (and this container's share of it), this container's memory,
 * and how late the event loop runs, each now and with its recent history. The media service's GPU is ems's (`ems-gpu`).
 *
 * Read back from `metrics-sampler`'s series (see ./lib.ts), so it answers the same on a laptop
 * in a harness with no cgroup and before the sampler has ticked: an absent source is an absent
 * field, not a zero.
 */

import { parseArgs } from '../../../../lib/args/mod.ts';
import {
  type CpuEntry,
  cpuPercent,
  downsample,
  hostCpuPercent,
  type MemoryEntry,
  percent,
  type RuntimeEntry,
  type Sample,
  TICK_MS,
  within,
} from '../../../../lib/metrics/mod.ts';
import type { HostMetrics, MetricPoint } from '../../../../lib/api/system.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { fmtBytes, fmtPct, HOUR, latest, MINUTE, POINTS, readSeries, toPoints } from './lib.ts';

/** History window. Overridable with `--window`. */
const DEFAULT_WINDOW_MS = 6 * HOUR;

/** Parse `--window <minutes>`; at least a minute. */
const windowFlag = (value: string | undefined): number => value ? Math.max(MINUTE, Number(value) * MINUTE) : DEFAULT_WINDOW_MS;

/**
 * Rows of a series at the sampler's tick that cover `windowMs`, twice over for a stretch written
 * denser (a restart, a shorter `--interval`): 1600 at most, ~6.5h at the 15s tick.
 */
const rowsFor = (windowMs: number): number => Math.min(1600, Math.ceil(windowMs / TICK_MS) * 2 + 2);

/**
 * The machine's CPU as a rolling series: each point is the utilization between it and the
 * point before, which is the only thing a cumulative counter can say.
 */
const cpuSeries = (samples: Sample<CpuEntry>[]): MetricPoint[] => {
  const thinned = downsample(samples, POINTS + 1);
  const points: MetricPoint[] = [];

  for (let i = 1; i < thinned.length; i++) {
    const value = hostCpuPercent([thinned[i - 1], thinned[i]]);
    if (value !== undefined) points.push({ at: thinned[i].at, value });
  }

  return points;
};

export const readHostMetrics = async (cmd: Command, windowMs: number = DEFAULT_WINDOW_MS): Promise<HostMetrics> => {
  const rows = rowsFor(windowMs);
  const [cpuAll, memoryAll, runtimeAll] = await Promise.all([
    readSeries<CpuEntry>(cmd, 'cpu', rows),
    readSeries<MemoryEntry>(cmd, 'memory', rows),
    readSeries<RuntimeEntry>(cmd, 'runtime', rows),
  ]);

  const cpuNow = latest(cpuAll);
  const cpu = cpuNow
    ? {
      // The last pair, not the window average: "CPU now" means the interval
      // that just elapsed. One sampling interval is a wide enough span for a
      // microsecond counter (see GAUGE_MIN_SPAN_MS).
      percent: hostCpuPercent(cpuAll.slice(-2)),
      ownPercent: cpuPercent(cpuAll.slice(-2)),
      cores: cpuNow.cores,
      load1: cpuNow.load1,
      series: cpuSeries(within(cpuAll, windowMs)),
    }
    : undefined;

  const memoryNow = latest(memoryAll);
  const memory = memoryNow
    ? {
      usedBytes: memoryNow.usedBytes,
      limitBytes: memoryNow.limitBytes,
      percent: percent(memoryNow.usedBytes, memoryNow.limitBytes),
      series: toPoints(within(memoryAll, windowMs), (entry) => percent(entry.usedBytes, entry.limitBytes)),
    }
    : undefined;

  const lagNow = latest(runtimeAll)?.lag;
  const lag = lagNow
    ? {
      p99Ms: lagNow.p99Ms,
      maxMs: lagNow.maxMs,
      series: toPoints(within(runtimeAll, windowMs), (entry) => entry.lag?.p99Ms),
    }
    : undefined;

  return { cpu, memory, lag, sampled: cpuAll.length > 0 || memoryAll.length > 0 || runtimeAll.length > 0 };
};

const writeHostMetrics = async (cmd: Command, { cpu, memory, lag }: HostMetrics): Promise<void> => {
  if (cpu) {
    const load = cpu.load1 !== undefined ? `  load ${cpu.load1.toFixed(2)}` : '';
    await cmd.writeLn(`cpu     ${fmtPct(cpu.percent)} of ${cpu.cores} cores${load}  EiN ${fmtPct(cpu.ownPercent)}`);
  }
  if (memory) await cmd.writeLn(`memory  ${fmtPct(memory.percent)}  ${fmtBytes(memory.usedBytes)} of ${fmtBytes(memory.limitBytes)}`);
  if (lag) await cmd.writeLn(`lag     p99 ${lag.p99Ms.toFixed(1)} ms  max ${lag.maxMs.toFixed(1)} ms`);
};

export const hostMetrics = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['window'] });
  const metrics = await readHostMetrics(cmd, windowFlag(flags.window));

  if (cmd.json) {
    await cmd.writeJSON(metrics satisfies HostMetrics);
    return 0;
  }

  if (!metrics.sampled) await cmd.writeLn('no metrics sampled yet — is metrics-sampler running?');
  await writeHostMetrics(cmd, metrics);
  return 0;
};

hostMetrics.spec = {
  name: 'host-metrics',
  effect: 'read' as const,
  description: "The machine's CPU, this container's memory and event-loop lag now, with their recent history from metrics-sampler",
  args: [],
  flags: [
    { name: 'window', type: 'string' as const, description: 'Minutes of history (default: 360)' },
  ],
};
