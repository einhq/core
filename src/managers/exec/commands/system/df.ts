/**
 * df — free space per storage tier, how fast it is going, and the database's size and its largest
 * tables.
 *
 * The projection is the reason this exists beside a plain free-space figure: a crawl that writes
 * derivatives faster than anyone checks on it fills a disk that reads "3% used" today. Read from
 * `metrics-sampler`'s `disk` series, which carries the history the trend needs; the database's
 * figures are live, from `pg_database_size` and `pg_total_relation_size`.
 */

import { type DiskEntry, percent, rate, within } from '../../../../lib/metrics/mod.ts';
import type { DatabaseTable, DiskUsage, StorageTier } from '../../../../lib/api/system.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { DAY, fmtBytes, fmtPct, latest, readSeries } from './lib.ts';

/** Disk fills over days, so its trend needs days of history to be worth anything. */
const DISK_WINDOW_MS = 7 * DAY;

/** How many of the largest tables are named; the rest of the database is what they leave. */
const TABLES = 5;

/**
 * The database's size and its largest tables, each with its indexes and TOAST. A partitioned
 * table's own size is nothing, so its partitions (and TimescaleDB's chunks) are counted one by one
 * in what the named tables leave.
 */
const databaseUsage = async (cmd: Command): Promise<{ bytes?: number; tables?: DatabaseTable[] }> => {
  if (!cmd.sys.pgPool) return {};
  try {
    const conn = await cmd.sys.pgPool.connect();
    try {
      // ::text because both sizes are bigint, which the driver hands back as a string anyway.
      const size = await conn.query<{ size: string }>('SELECT pg_database_size(current_database())::text AS size');
      const tables = await conn.query<{ name: string; size: string }>(
        `SELECT c.relname AS name, pg_total_relation_size(c.oid)::text AS size
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          ORDER BY pg_total_relation_size(c.oid) DESC
          LIMIT ${TABLES}`,
      );
      const bytes = Number(size.rows[0]?.size);
      return {
        bytes: Number.isFinite(bytes) ? bytes : undefined,
        tables: tables.rows.map((row) => ({ name: row.name, bytes: Number(row.size) })),
      };
    } finally {
      conn.release();
    }
  } catch {
    return {};
  }
};

export const readDiskUsage = async (cmd: Command): Promise<DiskUsage> => {
  const [diskAll, database] = await Promise.all([
    readSeries<DiskEntry>(cmd, 'disk', 700), // 15min -> ~7.3d, the growth trend
    databaseUsage(cmd),
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

  return { tiers, databaseBytes: database.bytes, databaseTables: database.tables };
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
  for (const table of usage.databaseTables ?? []) await cmd.writeLn(`  ${table.name.padEnd(36)} ${fmtBytes(table.bytes)}`);
  return 0;
};

df.spec = {
  name: 'df',
  effect: 'read' as const,
  description: 'Free space per storage tier, its growth per day and when it fills, and the database size and its largest tables',
  args: [],
};
