/**
 * Host resource probes — CPU and memory as the kernel reports them.
 *
 * Every probe reads cgroup v2 rather than `/proc`, because EiN runs in a
 * container: `/proc/meminfo` and `/proc/stat` are the *host's* numbers, so a
 * dashboard built on them would show 15 GiB of RAM on a container capped at
 * 10g and CPU time spent by processes we do not own. The cgroup files are
 * scoped to us.
 *
 * CPU is exposed as a cumulative counter (`usageUsec`), never as a percentage.
 * A percentage needs two observations and this is one, so the rate is derived
 * where two samples are in hand — see `rate()` in `derive.ts`.
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

export type CpuSample = {
  /** Cumulative CPU time consumed by this cgroup, microseconds. */
  usageUsec: number;
  /** Cores available, so a rate can be turned into a percentage. */
  cores: number;
  /** 1-minute load average. Host-wide — the kernel has no per-cgroup load. */
  load1?: number;
};

export type MemorySample = {
  usedBytes: number;
  /** The cgroup cap, or the host total when the cgroup is unlimited ("max"). */
  limitBytes?: number;
};

export const sampleCpu = async (): Promise<CpuSample | undefined> => {
  const text = await readText(`${CGROUP}/cpu.stat`);
  if (text === undefined) return undefined;

  const usageUsec = flatKey(text, 'usage_usec');
  if (usageUsec === undefined) return undefined;

  let load1: number | undefined;
  try {
    load1 = Deno.loadavg()[0];
  } catch {
    // --allow-sys not granted; the counter alone is still useful.
  }

  return { usageUsec, cores: navigator.hardwareConcurrency, load1 };
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

  if (limitBytes === undefined) {
    try {
      limitBytes = Deno.systemMemoryInfo().total;
    } catch {
      // --allow-sys not granted; report usage without a ceiling.
    }
  }

  return { usedBytes, limitBytes };
};
