/**
 * Disk capacity from `df`: per storage tier root, and the machine's disks.
 *
 * Deno has no statvfs, so this shells out. `df -Pk` is the POSIX output format:
 * one header line, then one line per operand with 1K blocks, which is stable
 * across the coreutils and busybox implementations. `-P` also guarantees the
 * record stays on one line, which the default format does not when the device
 * name is long.
 *
 * Several tiers usually resolve to one filesystem, so the device is reported and the UI
 * collapses the duplicates.
 * The alternative — reporting 1.8 TB free three times — reads as 5.4 TB.
 */

import type { FileTier } from '../../registries/file/types.ts';

export type DiskSample = {
  tier: FileTier;
  path: string;
  device: string;
  totalBytes: number;
  freeBytes: number;
};

/** Tier roots as the boot mount sees them, in display order. */
export type TierRoots = { tier: FileTier; path: string }[];

/** One line of `df -Pk`: the filesystem's source, its size and free space in bytes, and where it is mounted. */
type DfLine = { device: string; totalBytes: number; freeBytes: number; mount: string };

/**
 * `df -Pk` over `operands` (every mounted filesystem without any), one line each in their order.
 * A missing operand makes df exit non-zero while still reporting the rest, so the output is
 * parsed either way and the unmatched fall out.
 */
const df = async (operands: string[]): Promise<DfLine[]> => {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command('df', { args: ['-Pk', ...operands], stdout: 'piped', stderr: 'null' }).output();
  } catch {
    return [];
  }
  return parseDf(new TextDecoder().decode(output.stdout));
};

/** The lines of `df -Pk` output, past its header; a line that does not parse is left out. */
export const parseDf = (text: string): DfLine[] => {
  const lines: DfLine[] = [];
  for (const line of text.split('\n').slice(1).filter(Boolean)) {
    // device 1024-blocks used available capacity mounted-on; the mount may hold spaces.
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;
    const total = Number(parts[1]);
    const free = Number(parts[3]);
    if (!Number.isFinite(total) || !Number.isFinite(free)) continue;
    lines.push({ device: parts[0], totalBytes: total * 1024, freeBytes: free * 1024, mount: parts.slice(5).join(' ') });
  }
  return lines;
};

export const sampleDisk = async (roots: TierRoots): Promise<DiskSample[]> => {
  const wanted = roots.filter((root) => root.path);
  if (wanted.length === 0) return [];

  const lines = await df(wanted.map((root) => root.path));
  const samples: DiskSample[] = [];
  for (const [index, line] of lines.entries()) {
    // df preserves operand order, so the Nth line is the Nth root.
    const root = wanted[index];
    if (!root) continue;
    samples.push({ tier: root.tier, path: root.path, device: line.device, totalBytes: line.totalBytes, freeBytes: line.freeBytes });
  }
  return samples;
};

/** One of the machine's disks: its name (`sdc1`, `nvme0n1p2`, `vg-root`), size and free space. */
type VolumeSample = { name: string; totalBytes: number; freeBytes: number };

/**
 * The machine's disks as `df` sees them from here: each filesystem on a block device once,
 * whichever mount it is seen at. The rest (tmpfs, overlay, proc) are not disks; a container's
 * overlay root is on one of those that are.
 */
export const volumesOf = (lines: DfLine[]): VolumeSample[] => {
  const byName = new Map<string, VolumeSample>();
  for (const line of lines) {
    if (!line.device.startsWith('/dev/') || line.totalBytes <= 0) continue;
    const name = line.device.slice(line.device.lastIndexOf('/') + 1);
    if (name && !byName.has(name)) byName.set(name, { name, totalBytes: line.totalBytes, freeBytes: line.freeBytes });
  }
  return [...byName.values()];
};

export const sampleVolumes = async (): Promise<VolumeSample[]> => volumesOf(await df([]));
