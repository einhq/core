/**
 * df — free space per storage tier, how fast it is going, and the database's size.
 *
 * The projection is the reason this exists beside a plain free-space figure: a crawl that writes
 * derivatives faster than anyone checks on it fills a disk that reads "3% used" today. Read from
 * `metrics-sampler`'s `disk` series, which carries the history the trend needs; the database size
 * is one live `pg_database_size`.
 */

import { type DiskEntry, percent, rate, within } from '../../../../lib/metrics/mod.ts';
import type { DiskUsage, StorageTier } from '../../../../lib/api/system.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { DAY, fmtBytes, fmtPct, latest, readSeries } from './lib.ts';

/** Disk fills over days, so its trend needs days of history to be worth anything. */
const DISK_WINDOW_MS = 7 * DAY;

const databaseBytes = async (cmd: Command): Promise<number | undefined> => {
  if (!cmd.sys.pgPool) return undefined;
  try {
    const conn = await cmd.sys.pgPool.connect();
    try {
      // ::text because pg_database_size returns bigint, which the driver hands
      // back as a string anyway.
      const result = await conn.query<{ size: string }>('SELECT pg_database_size(current_database())::text AS size');
      const size = Number(result.rows[0]?.size);
      return Number.isFinite(size) ? size : undefined;
    } finally {
      conn.release();
    }
  } catch {
    return undefined;
  }
};

export const readDiskUsage = async (cmd: Command): Promise<DiskUsage> => {
  const [diskAll, dbBytes] = await Promise.all([
    readSeries<DiskEntry>(cmd, 'disk', 700), // 15min -> ~7.3d, the growth trend
    databaseBytes(cmd),
  ]);
  const diskWindow = within(diskAll, DISK_WINDOW_MS);

  const tiers: StorageTier[] = [];
  for (const disk of latest(diskAll) ?? []) {
    // Free space falling is the interesting direction, so the trend is measured
    // on *used* bytes — `rate` refuses to report a counter going backwards, and
    // a tier being written to is exactly free space going down.
    const usedPerMs = rate(diskWindow, (entry) => {
      const match = entry.find((sample) => sample.path === disk.path);
      return match ? match.totalBytes - match.freeBytes : undefined;
    });

    tiers.push({
      ...disk,
      usedPercent: percent(disk.totalBytes - disk.freeBytes, disk.totalBytes),
      bytesPerDay: usedPerMs === undefined ? undefined : Math.round(usedPerMs * DAY),
      daysUntilFull: usedPerMs === undefined || usedPerMs <= 0 ? undefined : Math.round(disk.freeBytes / usedPerMs / DAY),
    });
  }

  return { tiers, databaseBytes: dbBytes };
};

const writeTiers = async (cmd: Command, tiers: StorageTier[]): Promise<void> => {
  for (const tier of tiers) {
    const until = tier.daysUntilFull !== undefined ? `  full in ~${tier.daysUntilFull}d` : '';
    await cmd.writeLn(`tier    ${tier.tier.padEnd(9)} ${fmtPct(tier.usedPercent)} used  ${fmtBytes(tier.freeBytes)} free${until}`);
  }
};

export const df = async (cmd: Command): CmdReturn => {
  const usage = await readDiskUsage(cmd);

  if (cmd.json) {
    await cmd.writeJSON(usage satisfies DiskUsage);
    return 0;
  }

  if (usage.tiers.length === 0) await cmd.writeLn('no disk sample yet — is metrics-sampler running?');
  await writeTiers(cmd, usage.tiers);
  if (usage.databaseBytes !== undefined) await cmd.writeLn(`database  ${fmtBytes(usage.databaseBytes)}`);
  return 0;
};

df.spec = {
  name: 'df',
  effect: 'read' as const,
  description: 'Free space per storage tier, its growth per day and when it fills, and the database size',
  args: [],
};
