import { resolve } from '@std/path';
import type { LogReadBuckets, LogReadEntries } from '../../../../lib/api/streams.ts';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import { SYSTEM_TIME_ZONE } from '../../../../lib/datetime/timezone.ts';
import { LogHandle } from '../../../../registries/log/mod.ts';
import type { LogAggregate } from '../../../../registries/log/types.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { parseDuration } from '../pool/lib.ts';

const AGGREGATES: LogAggregate[] = ['avg', 'min', 'max', 'sum', 'count', 'first', 'last'];

/** The most entries one read hands out when `-n` does not say. */
const DEFAULT_LIMIT = 10_000;

/** A moment: an ISO 8601 time, or a duration (`24h`, `7d`) meaning that long ago. */
const parseMoment = (value: string | undefined, what: string): Date | undefined => {
  if (value === undefined) return undefined;
  if (/^\d+(\.\d+)?(ms|s|m|h|d)$/.test(value.trim())) return new Date(Date.now() - parseDuration(value, what)!);
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new Error(`invalid ${what} '${value}' (expected an ISO 8601 time, or a duration such as 24h or 7d meaning that long ago)`);
  return at;
};

/**
 * Read a log by time: the entries written in a range, or with `--bucket` the range summed up per
 * interval, as a chart wants it. As text, one `<time>\t<JSON>` line each, the form `cat -t` prints.
 *
 *   log-read <log> [--since 24h] [--until <time>] [-n 1000]
 *   log-read <log> --since 7d --bucket 1h [--field value] [--agg avg] [--tz Europe/Stockholm]
 */
export const logRead = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { string: ['since', 'until', 'bucket', 'field', 'agg', 'tz', 'n'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  const target = flags._[0] as string | undefined;
  if (!target) {
    await cmd.writeError('log-read: missing log path\n');
    return 1;
  }

  let since: Date | undefined;
  let until: Date | undefined;
  let bucketMs: number | undefined;
  let limit = DEFAULT_LIMIT;
  const aggregate = (flags.agg ?? 'avg') as LogAggregate;
  try {
    since = parseMoment(flags.since, '--since');
    until = parseMoment(flags.until, '--until');
    bucketMs = parseDuration(flags.bucket, '--bucket');
    if (bucketMs !== undefined && !(bucketMs >= 1000)) throw new Error(`--bucket takes a second or more, not ${flags.bucket}`);
    if (!AGGREGATES.includes(aggregate)) throw new Error(`--agg takes ${AGGREGATES.join(', ')}, not ${flags.agg}`);
    if (flags.n !== undefined) {
      limit = Number(flags.n);
      if (!Number.isInteger(limit) || limit < 1) throw new Error(`-n takes a whole number above 0, not ${flags.n}`);
    }
  } catch (error) {
    await cmd.writeError(`log-read: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const path = resolve(cmd.cwd, target);
  let handle;
  try {
    handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
  } catch (error) {
    await cmd.writeError(`log-read: ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  try {
    if (!(handle instanceof LogHandle)) {
      await cmd.writeError(`log-read: ${path}: not a log\n`);
      return 1;
    }
    if (bucketMs === undefined) {
      const entries = await handle.readRange({ since, until, limit });
      if (cmd.json) {
        await cmd.writeJSON({ entries: entries.map((entry) => ({ at: entry.createdAt.toISOString(), data: entry.data })) } satisfies LogReadEntries);
      } else {
        await cmd.write(entries.map((entry) => `${entry.createdAt.toISOString()}\t${JSON.stringify(entry.data)}\n`).join(''));
      }
      return 0;
    }
    const buckets = await handle.readBuckets({
      since,
      until,
      bucketSeconds: bucketMs / 1000,
      aggregate,
      field: flags.field ? String(flags.field).split('.').filter(Boolean) : undefined,
      timeZone: flags.tz || SYSTEM_TIME_ZONE,
    });
    const rows = buckets.slice(Math.max(0, buckets.length - limit)).map((bucket) => ({ at: bucket.at.toISOString(), value: bucket.value, count: bucket.count }));
    if (cmd.json) {
      await cmd.writeJSON({ buckets: rows } satisfies LogReadBuckets);
    } else {
      await cmd.write(rows.map((row) => `${row.at}\t${JSON.stringify({ value: row.value, count: row.count })}\n`).join(''));
    }
    return 0;
  } catch (error) {
    await cmd.writeError(`log-read: ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await handle.close();
  }
};

logRead.spec = {
  name: 'log-read',
  effect: 'read' as const,
  description:
    'Read a log by time: the entries written in a range, or with --bucket the range summed up per interval (an average an hour, a maximum a day), as a chart wants it',
  args: [{ name: 'log', type: 'path' as const, description: 'VFS path to the log node' }],
  flags: [
    { name: 'since', type: 'string' as const, description: 'from this time on: ISO 8601, or a duration such as 24h or 7d meaning that long ago' },
    { name: 'until', type: 'string' as const, description: 'before this time, as --since takes it' },
    { name: 'n', type: 'string' as const, description: `at most this many entries or intervals, the latest (${DEFAULT_LIMIT} when not given)` },
    { name: 'bucket', type: 'string' as const, description: 'sum the entries up per interval of this length: 5m, 1h, 1d' },
    { name: 'field', type: 'string' as const, description: 'with --bucket, the field to sum up, dotted (value, temperature.value); the entry itself when not given' },
    { name: 'agg', type: 'string' as const, description: `with --bucket, how: ${AGGREGATES.join(', ')} (avg when not given)` },
    { name: 'tz', type: 'string' as const, description: "with --bucket, the time zone a day or an hour is counted in (the system's when not given)" },
  ],
  examples: [
    'log-read /var/logs/metrics/cpu --since 1h',
    'log-read /archive/devices/hall-sensor/temperature/history --since 7d --bucket 1h --field value',
  ],
  returns: 'LogReadEntries { entries: [{at, data}] }, or with --bucket LogReadBuckets { buckets: [{at, value, count}] }',
};
