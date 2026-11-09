/**
 * host-metrics — the machine's CPU and memory (and this container's share of each),
 * and how late the event loop runs, each now and with its recent history. The media service's GPU is ems's (`ems-gpu`).
 *
 * The machine's figures are its device's readings (`/dev/<hostname>`), EiN's own share and the lag
 * `metrics-sampler`'s series (see ./lib.ts); both are what the sampler wrote, so this answers the
 * same on a laptop in a harness with no cgroup and before the sampler has ticked: an absent source
 * is an absent field, not a zero.
 */

import { parseArgs } from '../../../../lib/args/mod.ts';
import { type CpuEntry, cpuPercent, type MemoryEntry, percent, type RuntimeEntry, TICK_MS, within } from '../../../../lib/metrics/mod.ts';
import { deviceHistory } from '../../../devices/read.ts';
import { thisHost } from '../../../devices/host.ts';
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

/** One of this machine's device readings: its latest value, and its history over `windowMs` averaged into chart points. */
const machineReading = async (cmd: Command, endpoint: string, windowMs: number): Promise<{ now?: number; series: MetricPoint[] }> => {
  const device = thisHost().name;
  try {
    const [latest, history] = await Promise.all([
      deviceHistory(cmd.sys.vfs, cmd.access, device, endpoint, { limit: 1 }),
      deviceHistory(cmd.sys.vfs, cmd.access, device, endpoint, {
        since: new Date(Date.now() - windowMs),
        limit: POINTS,
        bucket: { seconds: Math.max(TICK_MS / 1000, Math.ceil(windowMs / 1000 / POINTS)), aggregate: 'avg' },
      }),
    ]);
    const value = latest.readings.at(-1)?.value;
    const series = history.readings.flatMap((reading) => typeof reading.value === 'number' ? [{ at: Date.parse(reading.at), value: reading.value }] : []);
    return { now: typeof value === 'number' ? value : undefined, series };
  } catch {
    // No device yet, or not one this account may read.
    return { series: [] };
  }
};

export const readHostMetrics = async (cmd: Command, windowMs: number = DEFAULT_WINDOW_MS): Promise<HostMetrics> => {
  const rows = rowsFor(windowMs);
  const [cpuAll, memoryAll, runtimeAll, machineCpu, machineLoad, machineMemory, machineTotal] = await Promise.all([
    readSeries<CpuEntry>(cmd, 'cpu', rows),
    readSeries<MemoryEntry>(cmd, 'memory', rows),
    readSeries<RuntimeEntry>(cmd, 'runtime', rows),
    machineReading(cmd, 'cpu', windowMs),
    machineReading(cmd, 'load', MINUTE),
    machineReading(cmd, 'memory-used', windowMs),
    machineReading(cmd, 'memory-total', MINUTE),
  ]);

  const cpuNow = latest(cpuAll);
  const cpu = cpuNow
    ? {
      percent: machineCpu.now,
      // The last pair, not the window average: "CPU now" means the interval
      // that just elapsed. One sampling interval is a wide enough span for a
      // microsecond counter (see GAUGE_MIN_SPAN_MS).
      ownPercent: cpuPercent(cpuAll.slice(-2)),
      cores: cpuNow.cores,
      load1: machineLoad.now,
      series: machineCpu.series,
    }
    : undefined;

  const memoryNow = latest(memoryAll);
  // The machine's total is in GB of 1024³ bytes, as its device keeps it.
  const totalBytes = machineTotal.now !== undefined ? machineTotal.now * 2 ** 30 : undefined;
  const memory = memoryNow
    ? {
      usedBytes: memoryNow.usedBytes,
      limitBytes: memoryNow.limitBytes,
      percent: percent(memoryNow.usedBytes, memoryNow.limitBytes),
      series: toPoints(within(memoryAll, windowMs), (entry) => percent(entry.usedBytes, entry.limitBytes)),
      ...(machineMemory.now !== undefined && totalBytes !== undefined
        ? { machine: { usedBytes: Math.round(totalBytes * machineMemory.now / 100), totalBytes, percent: machineMemory.now, series: machineMemory.series } }
        : {}),
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

  return { cpu, memory, lag, sampled: cpuAll.length > 0 || memoryAll.length > 0 || runtimeAll.length > 0, device: thisHost().name };
};

const writeHostMetrics = async (cmd: Command, { cpu, memory, lag }: HostMetrics): Promise<void> => {
  if (cpu) {
    const load = cpu.load1 !== undefined ? `  load ${cpu.load1.toFixed(2)}` : '';
    await cmd.writeLn(`cpu     ${fmtPct(cpu.percent)} of ${cpu.cores} cores${load}  EiN ${fmtPct(cpu.ownPercent)}`);
  }
  if (memory?.machine) await cmd.writeLn(`memory  ${fmtPct(memory.machine.percent)}  ${fmtBytes(memory.machine.usedBytes)} of ${fmtBytes(memory.machine.totalBytes)}`);
  if (memory) await cmd.writeLn(`ein     ${fmtPct(memory.percent)}  ${fmtBytes(memory.usedBytes)} of ${fmtBytes(memory.limitBytes)}`);
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
  description: "The machine's CPU and memory, this container's share of each, and event-loop lag now, with their recent history from metrics-sampler",
  args: [],
  flags: [
    { name: 'window', type: 'string' as const, description: 'Minutes of history (default: 360)' },
  ],
};
