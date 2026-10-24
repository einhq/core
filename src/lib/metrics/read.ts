/**
 * Reading a metrics series back out of its log.
 *
 * The log registry has two readers and only one of them is usable here:
 * `read()` returns the entry payloads as NDJSON and drops `createdAt`, while
 * `readEntries()` keeps it. A time series without timestamps is a list, so
 * everything below goes through `readEntries`.
 */

import { ResourceSeekMode } from '../../registries/types.ts';
import type { LogHandle } from '../../registries/log/log-handle.ts';
import type { Access } from '../access/mod.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import type { Sample } from './sample.ts';

/**
 * The last `limit` entries of a log, oldest first.
 *
 * Returns an empty series when the log does not exist yet: the sampler creates
 * these on its first run, and the dashboard has to render on a boot where it
 * has not run at all.
 */
export const readTail = async <T>(
  vfs: NodeVFS,
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
