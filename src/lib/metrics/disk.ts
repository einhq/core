/**
 * Storage tier capacity — `df` per tier root.
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
  /** Tier name, or `tmp` for the scratch root, which is not a storage tier. */
  tier: FileTier | 'tmp';
  path: string;
  device: string;
  totalBytes: number;
  freeBytes: number;
};

/** Tier roots as the boot mount sees them, in display order. */
export type TierRoots = { tier: FileTier | 'tmp'; path: string }[];

export const sampleDisk = async (roots: TierRoots): Promise<DiskSample[]> => {
  const wanted = roots.filter((root) => root.path);
  if (wanted.length === 0) return [];

  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command('df', {
      args: ['-Pk', ...wanted.map((root) => root.path)],
      stdout: 'piped',
      stderr: 'null',
    }).output();
  } catch {
    return [];
  }

  // A missing operand makes df exit non-zero while still reporting the rest, so
  // parse the output either way and let unmatched roots fall out.
  const lines = new TextDecoder().decode(output.stdout).split('\n').slice(1).filter(Boolean);

  const samples: DiskSample[] = [];
  for (const [index, line] of lines.entries()) {
    // device 1024-blocks used available capacity mounted-on
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;

    const total = Number(parts[1]);
    const free = Number(parts[3]);
    if (!Number.isFinite(total) || !Number.isFinite(free)) continue;

    // df preserves operand order, so the Nth line is the Nth root.
    const root = wanted[index];
    if (!root) continue;

    samples.push({
      tier: root.tier,
      path: root.path,
      device: parts[0],
      totalBytes: total * 1024,
      freeBytes: free * 1024,
    });
  }

  return samples;
};
