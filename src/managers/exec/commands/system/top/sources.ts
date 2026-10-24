/**
 * What `top` shows, and how often each part of it is read again.
 *
 * CPU, memory and the heap are probed on every tick: they move from second to second, and the
 * graph is drawn from them. Everything else is what a shell would ask the commands for — `ps`,
 * `who`, `host-metrics`, `df`, `pipeline-overview`, `pool-stat`, `service-list --detail`, `gauges`
 * and `dmesg --level warn` — read through their own readers, so the numbers are the system
 * dashboard's, each on the cadence those numbers change at. `health`'s verdict is made from the
 * work and pools read here and the two reads only it needs. Every read runs on its own: a slow
 * one holds back its own panel and nothing else.
 */

import { getHeapStatistics } from 'node:v8';
import { SYSTEM_LOG_PATH } from '../../../../../lib/paths.ts';
import { cpuPercent, type CpuSample, type MemorySample, type Sample, sampleCpu, sampleMemory } from '../../../../../lib/metrics/mod.ts';
import type {
  DiskUsage,
  Gauge,
  HealthCheck,
  HostMetrics,
  LogLine,
  MetricPoint,
  PoolStatAnswer,
  ProcessEntry,
  ServiceEntry,
  SessionEntry,
  SystemInfo,
} from '../../../../../lib/api/system.ts';
import type { PipelineOverview } from '../../../../../lib/api/pipeline.ts';
import type { Command } from '../../../command.ts';
import { readPipelineOverview } from '../../pipeline/pipeline-overview.ts';
import { statAllPools } from '../../pool/pool-stat.ts';
import { listServices } from '../../service/service-list.ts';
import { LEVELS, readLogLines } from '../../utils/dmesg.ts';
import { readDiskUsage } from '../df.ts';
import { type Attention, readAttention, readGauges, serviceChecks } from '../health.ts';
import { readHostMetrics } from '../host-metrics.ts';
import { MINUTE } from '../lib.ts';
import { listProcesses } from '../ps.ts';
import { readSystemInfo } from '../system-info.ts';
import { listSessions } from '../who.ts';

/** CPU readings kept for the graph: more than any terminal is wide. */
const HISTORY = 600;

/** The shortest span a CPU reading is taken over; a refresh right after a tick waits for the next. */
const CPU_MIN_SPAN_MS = 250;

/** Warnings and errors kept from the system log, newest last. */
const PROBLEMS = 20;

export type TopData = {
  info: SystemInfo;
  /** Load average over 1, 5 and 15 minutes, host-wide as the kernel keeps it. */
  load?: number[];
  /** Cores the CPU percentage is a share of; absent where there is no cgroup CPU counter. */
  cores?: number;
  /** CPU use as a percentage of all cores, one reading per tick, oldest first. */
  cpu: MetricPoint[];
  memory?: MemorySample;
  /** This process's JavaScript heap, against the size V8 stops it at. */
  heap: { usedBytes: number; limitBytes: number };
  host?: HostMetrics;
  disk?: DiskUsage;
  work?: PipelineOverview;
  pools?: PoolStatAnswer[];
  /** What `health` reads besides the work and the pools. */
  attention?: Attention;
  serviceChecks?: HealthCheck[];
  /** Services' meters, drawn beside RAM and the heap. */
  gauges?: Gauge[];
  services?: ServiceEntry[];
  processes?: ProcessEntry[];
  sessions?: SessionEntry[];
  problems?: LogLine[];
  /** Why a source's last read failed, by source; a later read that works clears it. */
  errors: Record<string, string>;
};

type Source = {
  name: string;
  /** How long a reading stands; 0 is every tick. */
  everyMs: number;
  read: (cmd: Command) => Promise<Partial<TopData>>;
};

const SOURCES: Source[] = [
  { name: 'processes', everyMs: 0, read: async (cmd) => ({ processes: await listProcesses(cmd) }) },
  { name: 'sessions', everyMs: 0, read: async (cmd) => ({ sessions: await listSessions(cmd) }) },
  // The lag, and the sampler's CPU readings: the graph's history before the first probe, and
  // the figure until two probes are in.
  { name: 'host', everyMs: 15_000, read: async (cmd) => ({ host: await readHostMetrics(cmd, 30 * MINUTE) }) },
  { name: 'work', everyMs: 10_000, read: async (cmd) => ({ work: await readPipelineOverview(cmd) }) },
  { name: 'pools', everyMs: 10_000, read: async (cmd) => ({ pools: await statAllPools(cmd) }) },
  { name: 'services', everyMs: 15_000, read: async (cmd) => ({ services: await listServices(cmd, true) }) },
  {
    name: 'health',
    everyMs: 15_000,
    read: async (cmd) => {
      const [attention, checks] = await Promise.all([readAttention(cmd), serviceChecks(cmd)]);
      return { attention, serviceChecks: checks };
    },
  },
  { name: 'gauges', everyMs: 15_000, read: async (cmd) => ({ gauges: await readGauges(cmd) }) },
  {
    name: 'problems',
    everyMs: 10_000,
    read: async (cmd) => ({ problems: await readLogLines(cmd, SYSTEM_LOG_PATH, { minLevel: LEVELS.indexOf('WARN'), limit: PROBLEMS }) }),
  },
  // Free space moves over hours, and the database size is a query of its own.
  { name: 'disk', everyMs: 60_000, read: async (cmd) => ({ disk: await readDiskUsage(cmd) }) },
];

const heap = (): TopData['heap'] => {
  const stats = getHeapStatistics();
  return { usedBytes: stats.used_heap_size, limitBytes: stats.heap_size_limit };
};

const loadAverage = (): number[] | undefined => {
  try {
    return Deno.loadavg();
  } catch {
    // --allow-sys not granted.
    return undefined;
  }
};

export class TopSources {
  readonly data: TopData;
  private due = new Map<string, number>();
  private reading = new Map<string, Promise<void>>();
  private lastCpu?: Sample<CpuSample>;

  /** `changed` is called whenever a read that ran on its own has come in. */
  constructor(private cmd: Command, private changed: () => void = () => {}) {
    this.data = { info: readSystemInfo(), cpu: [], heap: heap(), errors: {} };
  }

  /** Starts every read that is due, then probes the live numbers; resolves once the probes are in. */
  async tick(now = Date.now()): Promise<void> {
    for (const source of SOURCES) {
      if (this.reading.has(source.name) || now < (this.due.get(source.name) ?? 0)) continue;
      this.due.set(source.name, now + source.everyMs);
      const reading = source.read(this.cmd)
        .then((value) => {
          Object.assign(this.data, value);
          delete this.data.errors[source.name];
        })
        .catch((error) => {
          this.data.errors[source.name] = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          this.reading.delete(source.name);
          this.changed();
        });
      this.reading.set(source.name, reading);
    }
    await this.probe(now);
  }

  /** Resolves when every read started so far has come in. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.reading.values()]);
  }

  /** Makes every source due on the next tick, whatever its cadence. */
  expire(): void {
    this.due.clear();
  }

  private async probe(now: number): Promise<void> {
    const [cpu, memory] = await Promise.all([sampleCpu(), sampleMemory()]);
    this.data.info = readSystemInfo();
    this.data.load = loadAverage();
    this.data.heap = heap();
    this.data.memory = memory;

    if (!cpu) return;
    this.data.cores = cpu.cores;
    const sample = { at: now, value: cpu };
    const percent = this.lastCpu ? cpuPercent([this.lastCpu, sample], CPU_MIN_SPAN_MS) : undefined;
    if (percent !== undefined) {
      this.data.cpu.push({ at: now, value: percent });
      if (this.data.cpu.length > HISTORY) this.data.cpu.splice(0, this.data.cpu.length - HISTORY);
      this.lastCpu = sample;
    } else if (!this.lastCpu || cpu.usageUsec < this.lastCpu.value.usageUsec) {
      // The first probe, or the counter started over: this is the reading the next is measured from.
      this.lastCpu = sample;
    }
  }
}
