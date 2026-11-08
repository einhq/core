/**
 * Reading a series back out of a log: a metrics series, or any log of readings.
 *
 * The log registry's `read()` returns the entry payloads as NDJSON and drops `createdAt`. A time
 * series without timestamps is a list, so everything below goes through the handle's readers that
 * keep it: `readEntries` for the latest entries, `readRange` and `readBuckets` by time.
 */

import { ResourceSeekMode } from '../../registries/types.ts';
import type { LogHandle } from '../../registries/log/log-handle.ts';
import type { Access } from '../access/mod.ts';
import type { ModuleVFS } from '../../vfs/node-vfs.ts';
import type { LogBucketQuery } from '../../registries/log/types.ts';
import type { BucketSample, Sample } from './sample.ts';

/**
 * The last `limit` entries of a log, oldest first.
 *
 * Returns an empty series when the log does not exist yet: the sampler creates
 * these on its first run, and the dashboard has to render on a boot where it
 * has not run at all.
 */
export const readTail = async <T>(
  vfs: ModuleVFS,
  access: Access,
  path: string,
  limit: number,
): Promise<Sample<T>[]> => {
  let handle: LogHandle;
  try {
    handle = await vfs.open(access, path, { mode: 'r' }) as unknown as LogHandle;
  } catch {
    return [];
  }

  try {
    // Not a log node: `readEntries` is the log handle's own method, so anything
    // else opened at this path has no timestamps to give. The dashboard reports
    // an empty series rather than failing the whole payload over one panel.
    if (typeof handle.readEntries !== 'function') return [];

    // Seek positions the cursor so the next read *starts at* that entry, the
    // way `tail -n 1` seeks -1 and prints one line: seeking -limit and reading
    // `limit` ends at the newest entry.
    //
    // A log shorter than the window has no such entry and seek throws — reading
    // from the start is then already the whole series.
    try {
      await handle.seek(-limit, ResourceSeekMode.End);
    } catch {
      // Fewer than `limit` entries: the cursor stays before the first.
    }

    const entries = await handle.readEntries(limit);
    return entries.map((entry) => ({ at: entry.createdAt.getTime(), value: entry.data as T }));
  } catch {
    // A truncated or unreadable series must not take the dashboard with it.
    return [];
  } finally {
    await handle.close();
  }
};

/** The log at `path` opened to read, or undefined when there is none or it is not a log. */
const openLog = async (vfs: ModuleVFS, access: Access, path: string): Promise<LogHandle | undefined> => {
  let handle: LogHandle;
  try {
    handle = await vfs.open(access, path, { mode: 'r' }) as unknown as LogHandle;
  } catch {
    return undefined;
  }
  if (typeof handle.readRange === 'function') return handle;
  await handle.close();
  return undefined;
};

/**
 * The entries of a log written in `[since, until)`, oldest first; with `limit`, the latest that many.
 * An empty series when the log does not exist; the store's error when it cannot be read.
 */
export const readRange = async <T>(
  vfs: ModuleVFS,
  access: Access,
  path: string,
  range: { since?: Date; until?: Date; limit?: number },
): Promise<Sample<T>[]> => {
  const handle = await openLog(vfs, access, path);
  if (!handle) return [];
  try {
    return (await handle.readRange(range)).map((entry) => ({ at: entry.createdAt.getTime(), value: entry.data as T }));
  } finally {
    await handle.close();
  }
};

/**
 * A log's entries in `[since, until)` summed up per interval, oldest first (`LogBucketQuery` says
 * how). An empty series when the log does not exist; the store's error when it cannot be read.
 */
export const readBuckets = async (vfs: ModuleVFS, access: Access, path: string, query: LogBucketQuery): Promise<BucketSample[]> => {
  const handle = await openLog(vfs, access, path);
  if (!handle) return [];
  try {
    return (await handle.readBuckets(query)).map((bucket) => ({ at: bucket.at.getTime(), value: bucket.value, count: bucket.count }));
  } finally {
    await handle.close();
  }
};
