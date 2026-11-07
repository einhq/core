/**
 * Host resource probes — CPU and memory as the kernel reports them.
 *
 * EiN runs in a container, where `/proc/meminfo` and `/proc/stat` are the *host's* numbers and
 * cgroup v2 files are this container's. Both are kept, for memory as for CPU: the machine's, because
 * the work that loads it (the media service, the database) runs in other containers, and this
 * container's own, against its cap, which is what runs out first when EiN is short.
 *
 * CPU is exposed as cumulative counters, never as a percentage. A percentage needs two
 * observations and this is one, so the rate is derived where two samples are in hand — see
 * `derive.ts`.
 */

const CGROUP = '/sys/fs/cgroup';

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await Deno.readTextFile(path);
  } catch {
    // Not a cgroup v2 host, or the file is unreadable. Absent, not zero.
    return undefined;
  }
};

/** Pull `key <number>` out of a cgroup flat-keyed file. */
const flatKey = (text: string, key: string): number | undefined => {
  for (const line of text.split('\n')) {
    const [name, value] = line.split(' ');
    if (name === key) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
  }
  return undefined;
};

/** The machine's cumulative CPU time over all cores, in clock ticks: busy, and busy plus idle. */
export type HostCpuTicks = { busy: number; total: number };

export type CpuSample = {
  /** Cumulative CPU time consumed by this cgroup, microseconds. */
  usageUsec: number;
  /** The whole machine's CPU time, when `/proc/stat` is readable. */
  host?: HostCpuTicks;
  /** Cores available, so a rate can be turned into a percentage. */
  cores: number;
  /** 1-minute load average. Host-wide — the kernel has no per-cgroup load. */
  load1?: number;
};

export type MemorySample = {
  /** This container's resident memory. */
  usedBytes: number;
  /** The cgroup cap, or the host total when the cgroup is unlimited ("max"). */
  limitBytes?: number;
  /** The machine's memory and how much of it is available, as `/proc/meminfo` says; absent where unreadable. */
  host?: { totalBytes: number; availableBytes: number };
};

/**
 * The `cpu` line of `/proc/stat`: user, nice, system, idle, iowait, irq, softirq, steal (guest
 * time is already inside user and nice). Idle and iowait are the time no task ran.
 */
export const parseProcStat = (text: string): HostCpuTicks | undefined => {
  const line = text.split('\n').find((row) => row.startsWith('cpu '));
  if (!line) return undefined;
  const ticks = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (ticks.length < 5 || ticks.some((tick) => !Number.isFinite(tick))) return undefined;
  const total = ticks.reduce((sum, tick) => sum + tick, 0);
  return { busy: total - ticks[3] - ticks[4], total };
};

export const sampleCpu = async (): Promise<CpuSample | undefined> => {
  const [text, stat] = await Promise.all([readText(`${CGROUP}/cpu.stat`), readText('/proc/stat')]);
  if (text === undefined) return undefined;

  const usageUsec = flatKey(text, 'usage_usec');
  if (usageUsec === undefined) return undefined;
  const host = stat === undefined ? undefined : parseProcStat(stat);

  let load1: number | undefined;
  try {
    load1 = Deno.loadavg()[0];
  } catch {
    // --allow-sys not granted; the counter alone is still useful.
  }

  return { usageUsec, ...(host ? { host } : {}), cores: navigator.hardwareConcurrency, load1 };
};

export const sampleMemory = async (): Promise<MemorySample | undefined> => {
  const current = await readText(`${CGROUP}/memory.current`);
  if (current === undefined) return undefined;

  const usedBytes = Number(current.trim());
  if (!Number.isFinite(usedBytes)) return undefined;

  // "max" means unlimited, in which case the host's total is the real ceiling.
  const max = (await readText(`${CGROUP}/memory.max`))?.trim();
  let limitBytes = max !== undefined && max !== 'max' ? Number(max) : undefined;
  if (limitBytes !== undefined && !Number.isFinite(limitBytes)) limitBytes = undefined;

  let host: MemorySample['host'];
  try {
    const info = Deno.systemMemoryInfo();
    host = { totalBytes: info.total, availableBytes: info.available };
  } catch {
    // --allow-sys not granted; the container's numbers alone are still useful.
  }
  limitBytes ??= host?.totalBytes;

  return { usedBytes, limitBytes, ...(host ? { host } : {}) };
};
